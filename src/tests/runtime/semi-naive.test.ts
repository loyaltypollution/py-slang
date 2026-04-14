// Unit tests for the semi-naive evaluator under
// `src/specialization/runtime/datalog/`. No parser / Db / Query
// dependency — toy CFGs and a toy lattice only, isolating the iteration
// engine itself.

import {
  type BasicBlock,
  type CFG,
} from "../../specialization/framework/cfg";
import { MutableEnv } from "../../specialization/framework/mutable-env";
import type { Lattice } from "../../specialization/runtime/lattice";
import {
  type BlockTransfer,
  semiNaive,
} from "../../specialization/runtime/datalog/semi-naive";

// ── Toy: natural-number lattice max-joined in slot 0 ────────────────────

/**
 * Simplest lattice that exercises bottom / join / equals: natural number
 * in slot 0, join = max, bottom = MutableEnv with slot 0 unset.
 */
const numLattice: Lattice<MutableEnv<number>> = {
  bottom: new MutableEnv<number>(),
  equals: (a, b) => (a.get(0) ?? -1) === (b.get(0) ?? -1),
  join: (a, b) => {
    const merged = a.snapshot();
    const av = a.get(0);
    const bv = b.get(0);
    const next = Math.max(av ?? 0, bv ?? 0);
    merged.set(0, next);
    return merged;
  },
};

function envOf(n: number): MutableEnv<number> {
  const e = new MutableEnv<number>();
  e.set(0, n);
  return e;
}

// ── CFG builders (tests own their own topology; no parser needed) ───────

function makeBlock(id: number): BasicBlock {
  return {
    id,
    stmts: [],
    successors: [],
    predecessors: [],
  };
}

function link(from: BasicBlock, to: BasicBlock): void {
  from.successors.push(to);
  to.predecessors.push(from);
}

/**
 * Build a linear 3-block CFG: entry → mid → exit.
 */
function linearCFG(): CFG {
  const entry = makeBlock(0);
  const mid = makeBlock(1);
  const exit = makeBlock(2);
  link(entry, mid);
  link(mid, exit);
  return { entry, exit, blocks: [entry, mid, exit] };
}

/**
 * Build a loop CFG: entry → header ↔ body, header → exit.
 *
 *   entry → header → body
 *            ↑        │
 *            └────────┘
 *            │
 *           exit
 *
 * Forward edges: entry→header, header→body, body→header, header→exit.
 */
function loopCFG(): CFG {
  const entry = makeBlock(0);
  const header = makeBlock(1);
  const body = makeBlock(2);
  const exit = makeBlock(3);
  link(entry, header);
  link(header, body);
  link(body, header);
  link(header, exit);
  return { entry, exit, blocks: [entry, header, body, exit] };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("semiNaive", () => {
  test("monotone join converges on a linear CFG", () => {
    const cfg = linearCFG();
    // Entry IN = 5. Every block's transfer passes through unchanged.
    const transfer: BlockTransfer<number> = (env, _block) => env.snapshot();
    const { envs, changedBlocks } = semiNaive(
      cfg,
      numLattice,
      envOf(5),
      transfer,
    );
    expect(envs.get(0)?.get(0)).toBe(5);
    expect(envs.get(1)?.get(0)).toBe(5);
    expect(envs.get(2)?.get(0)).toBe(5);
    // All three blocks moved off bottom.
    expect(changedBlocks.size).toBe(3);
  });

  test("idempotent: second run from the same initial produces identical envs", () => {
    const cfg = linearCFG();
    const transfer: BlockTransfer<number> = (env, _block) => env.snapshot();
    const first = semiNaive(cfg, numLattice, envOf(5), transfer);
    const second = semiNaive(cfg, numLattice, envOf(5), transfer);
    for (const [blockId, env] of first.envs) {
      expect(numLattice.equals(env, second.envs.get(blockId)!)).toBe(true);
    }
  });

  test("change-propagation: block with higher transfer output flows to successors", () => {
    const cfg = linearCFG();
    // mid bumps to 10; entry + exit just pass through.
    const transfer: BlockTransfer<number> = (env, block) =>
      block.id === 1 ? envOf(10) : env.snapshot();
    const { envs, changedBlocks } = semiNaive(
      cfg,
      numLattice,
      envOf(5),
      transfer,
    );
    expect(envs.get(0)?.get(0)).toBe(5);
    expect(envs.get(1)?.get(0)).toBe(10);
    expect(envs.get(2)?.get(0)).toBe(10);
    expect(changedBlocks.has(1)).toBe(true);
    expect(changedBlocks.has(2)).toBe(true);
  });

  test("bottom-init discipline: loop body sees predecessor OUT that grew from bottom", () => {
    // This is the Phase 8 trap's tripwire. On a loop CFG a pure transfer
    // over `bottom` (empty env) must NOT widen to a pessimistic TOP; the
    // semi-naive loop initializes every OUT to bottom and only grows it
    // via monotone join, so the body's first read of the header OUT sees
    // 0-ish bottom and adds 1 — it does not see TOP.
    const cfg = loopCFG();
    // entry IN = 1. header passes through. body = IN + 1 (bounded to 3).
    const transfer: BlockTransfer<number> = (env, block) => {
      if (block.id === 2) {
        const cur = env.get(0) ?? 0;
        return envOf(Math.min(cur + 1, 3));
      }
      return env.snapshot();
    };
    const { envs } = semiNaive(cfg, numLattice, envOf(1), transfer);
    // Header IN = join(entry.OUT, body.OUT). body.OUT is bounded at 3.
    expect(envs.get(1)?.get(0)).toBe(3);
    expect(envs.get(2)?.get(0)).toBe(3);
    expect(envs.get(3)?.get(0)).toBe(3);
  });

  test("iteration cap throws on non-terminating (non-monotone) transfer", () => {
    // A transfer that always bumps by 1 without saturating is non-monotone
    // in the sense that it never converges; the cap fires.
    const cfg = loopCFG();
    const transfer: BlockTransfer<number> = (env, block) => {
      if (block.id === 2) {
        const cur = env.get(0) ?? 0;
        return envOf(cur + 1);
      }
      return env.snapshot();
    };
    expect(() =>
      semiNaive(cfg, numLattice, envOf(0), transfer, { iterationCap: 50 }),
    ).toThrow(/cap/);
  });

  test("changedBlocks: empty when transfer produces bottom everywhere", () => {
    const cfg = linearCFG();
    // Every transfer returns bottom. No block's OUT ever changes.
    const transfer: BlockTransfer<number> = (_env, _block) =>
      numLattice.bottom;
    const { changedBlocks } = semiNaive(
      cfg,
      numLattice,
      numLattice.bottom,
      transfer,
    );
    expect(changedBlocks.size).toBe(0);
  });

  test("changedBlocks: entry reports changed when entry transfer moves off bottom", () => {
    const cfg = linearCFG();
    // Entry IN = 5; transfer passes through. Entry OUT moves from bottom → 5.
    const transfer: BlockTransfer<number> = (env, _block) => env.snapshot();
    const { changedBlocks } = semiNaive(cfg, numLattice, envOf(5), transfer);
    expect(changedBlocks.has(0)).toBe(true);
  });
});
