// src/specialization/framework/dfa-factory.ts
//
// Factory that packages a Kildall-style block DFA into the framework's
// `Pass<K, V>` shape (plan item (a), Option A+C'): direction, merge-kind,
// and per-block transfer live in the factory's configuration object — not
// on the `Pass` interface — and the factory produces a *pair* of
// registered passes:
//
//   - `blockKeyedPass: Pass<BlockId, MutableEnv<L>>` — one Kildall step
//     per transfer. `affectedKeys` expands via CFG successors (forward)
//     or predecessors (backward).
//   - `nodeKeyedPass:  Pass<NodeId,  L>`             — projection of a
//     block's OUT env onto per-node facts that downstream consumers read.
//     Re-runs when its companion block-pass changes.
//
// Option C' (plan review resolution 2): block envs are a first-class
// registered pass, not hidden closure scratch. Introspection and
// invalidation are uniform across the fact store.
//
// PR-4 lands this factory as scaffolding. The existing legacy DFA driver
// in `worklist.ts` still powers production analyses; the factory's
// passes are constructed but their `transfer` is never invoked during
// drain unless callers deliberately enqueue. PR-5/PR-6 migrate callers.

import type { BasicBlock, BlockId, CFG } from "./cfg";
import type { FunctionUnit } from "./function-unit";
import { MutableEnv } from "./mutable-env";
import type { Lattice, Pass, PassCtx } from "./pass";
import { structuralPass } from "./structural-pass";

export type DfaDirection = "forward" | "backward";

export interface DfaConfig<L> {
  readonly debugName: string;
  readonly direction: DfaDirection;
  readonly bottom: L;
  readonly top: L;
  readonly leq: (a: L, b: L) => boolean;
  readonly join: (a: L, b: L) => L;
  readonly meet: (a: L, b: L) => L;
  readonly mergeKind: "may" | "must";
  /** Run one transfer over `block` given IN env; produce OUT env. */
  readonly transferBlock: (block: BasicBlock, inEnv: MutableEnv<L>, unit: FunctionUnit) => MutableEnv<L>;
  /** Seed the entry (forward) / exit (backward) block's IN env. */
  readonly seedEnv: (unit: FunctionUnit) => MutableEnv<L>;
  /** Project an OUT env into per-node values for downstream consumers. */
  readonly projectNode: (unit: FunctionUnit, nodeId: number, env: MutableEnv<L>) => L | undefined;
  /** The additional source pass this DFA reads (e.g. `runtimeWritePass`). */
  readonly reads: ReadonlyArray<Pass<any, any>>;
}

export interface DfaPasses<L> {
  readonly blockKeyedPass: Pass<BlockId, MutableEnv<L>>;
  readonly nodeKeyedPass: Pass<number, L>;
}

function incoming(block: BasicBlock, direction: DfaDirection): BasicBlock[] {
  return direction === "forward" ? block.predecessors : block.successors;
}

function outgoing(block: BasicBlock, direction: DfaDirection): BasicBlock[] {
  return direction === "forward" ? block.successors : block.predecessors;
}

function seedOf(cfg: CFG, direction: DfaDirection): BasicBlock {
  return direction === "forward" ? cfg.entry : cfg.exit;
}

/**
 * Build a pair of registered passes implementing a Kildall block DFA. The
 * caller registers both with the `Worklist` to make them participate in
 * the pass-graph dispatch. Both ship with `coarse: true` on the assumption
 * that `reads` churn dominates the mapping cost; a precision follow-on
 * can tighten later.
 *
 * Side-effect idempotence: `transfer` returns a fresh `MutableEnv` per
 * call; the fact store's `lattice.equals` check (via `envLatticeEquals`)
 * gates whether consumers are woken. A re-enqueue whose transfer produces
 * an equal env is absorbed silently.
 */
export function makeBlockFixpointPass<L>(config: DfaConfig<L>): DfaPasses<L> {
  const envLattice: Lattice<MutableEnv<L>> = {
    bottom: new MutableEnv<L>(),
    equals: (a, b) => a.equals(b, config.leq),
    join: (a, b) => {
      const merged = a.snapshot();
      if (config.mergeKind === "must") {
        merged.meetWith(b, config.meet, config.top);
      } else {
        merged.joinWith(b, config.join);
      }
      return merged;
    },
  };

  const nodeLattice: Lattice<L> = {
    bottom: config.bottom,
    equals: (a, b) => config.leq(a, b) && config.leq(b, a),
    join: config.join,
  };

  // Forward-declare refs so each pass's transfer closure can call ctx.read
  // against the companion pass. The `id` fields are needed up-front so
  // `reads` can embed mutual references without a two-phase init dance.
  const blockPassId = Symbol(`${config.debugName}:blocks`);
  const nodePassId = Symbol(`${config.debugName}:nodes`);

  // Block-keyed pass: Kildall one-step transfer. Reads config.reads + structuralPass.
  const blockKeyedPass: Pass<BlockId, MutableEnv<L>> = {
    id: blockPassId,
    debugName: `${config.debugName}:blocks`,
    lattice: envLattice,
    reads: [...config.reads, structuralPass],
    tier: "analysis",
    coarse: true,
    transfer(ctx: PassCtx, _blockId: BlockId): MutableEnv<L> | undefined {
      // Transfer body is a framework stub in PR-4 — the legacy DFA driver
      // in worklist.ts still powers production. PR-5 migrates callers to
      // enqueue this pass directly, at which point `ctx.read(blockKeyedPass,
      // predId)` resolves the predecessors' OUT envs and one step runs.
      return undefined;
    },
    prune(_ctx: PassCtx, _unit: FunctionUnit, previousKeys: Iterable<BlockId>): Iterable<BlockId> {
      // On structural change, every block key from the prior CFG is stale
      // (new CFG mints fresh BlockIds). Evict all and let the next drain
      // seed afresh.
      return Array.from(previousKeys);
    },
  };

  // Node-keyed pass: projects the block env onto each node. Reads the
  // block pass. PR-4 scaffolding — transfer is a no-op; the legacy DFA
  // driver populates node facts today.
  const nodeKeyedPass: Pass<number, L> = {
    id: nodePassId,
    debugName: `${config.debugName}:nodes`,
    lattice: nodeLattice,
    reads: [blockKeyedPass, structuralPass],
    tier: "analysis",
    coarse: true,
    transfer(_ctx: PassCtx, _nodeId: number): L | undefined {
      return undefined;
    },
  };

  // Silence unused-param warnings while scaffolding; runtime paths touch
  // these once PR-5 wires drain to the factory.
  void seedOf;
  void incoming;
  void outgoing;

  return { blockKeyedPass, nodeKeyedPass };
}
