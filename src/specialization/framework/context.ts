// A speculation context is a path of assumptions through an immutable tree.
// Root = ∅ = "assume nothing." A child extends its parent with a single
// assumption of the form "for narrowing N, key K, the assumed value is V".
// Transfer functions running under a non-root context meet their computed fact
// with any ancestor assumption that applies to the (narrowing, key) being
// computed.
//
// Operations on AssumptionChain are navigational (parent, depth, findAssumption) —
// never lattice-valued (join, meet). Two chains are not combined. Siblings
// represent independent speculations; a path from root to a leaf is the
// chain one compiled version depends on.
//
// Chains are canonicalized and interned: `extendContext` / `excludeAssumption`
// return a canonical AssumptionChain keyed by the assumption *set*. Two call paths
// that converge on the same set produce `===` references, so every AssumptionChain-
// keyed structure downstream (per-analysis stores, JIT cache, worklist
// pending set) de-fragments automatically. Canonical order is
// `(narrowing.debugName, key)` ascending; the interner lives in
// `./context-interner.ts`.

import type { StmtNS } from "../../ast-types";
import type { Analysis, AssumptionHandle, Reading } from "./analysis";
import { defaultInterner } from "./context-interner";
import type { BlockFixpointAnalysis } from "./dfa-factory";
import type { Unit } from "./function-unit";
import type { ProgramTopology } from "./topology";

export interface Assumption<K = unknown, V = unknown> {
  readonly narrowing: AssumptionHandle<K, V>;
  readonly key: K;
  readonly value: V;
}

/** Reading surface for facts under this chain.
 *
 *  The chain IS the reader. `analysis.store.*` is an implementation detail
 *  surfaced only to framework internals (worklist, DFA factory) that implement
 *  these methods; consumers (analyses, transforms, tests) read through a
 *  chain. This keeps the contract structural: a helper with no chain argument
 *  cannot read facts — there is no other API. */
export interface AssumptionChain {
  readonly parent: AssumptionChain | undefined;
  readonly assumption: Assumption | undefined;
  readonly depth: number;
  /** Exact positional read at this chain. Uses the store's `read()` default
   *  (`emptyValue` / `storeAlgebra.bottom`) for unwritten cells. */
  read<K, V>(analysis: Analysis<K, V>, key: K): V;
  /** Exact positional read; `undefined` for unwritten cells. */
  tryRead<K, V>(analysis: Analysis<K, V>, key: K): V | undefined;
  /** Witness-carrying variant of `read`: returns `{ value, witness: this }`.
   *  Useful as an authorization seed for `forkBody` when a rule's rewrite
   *  is justified by an analysis at the sweep's own chain. */
  readAt<K, V>(analysis: Analysis<K, V>, key: K): Reading<V>;
  /** Walk `this → ROOT`, returning the shallowest ancestor whose written
   *  cell value satisfies `accept`. Unwritten ancestor cells are skipped. */
  readMinimal<K, V>(
    analysis: Analysis<K, V>,
    key: K,
    accept: (value: V) => boolean,
  ): Reading<V> | undefined;
  /** Per-expression block-DFA read at this chain. Returns `undefined` when
   *  the node is unknown to `topology` or the block's facts cell has no
   *  entry for that node. */
  readExprFactAt<L>(
    topology: ProgramTopology,
    analysis: BlockFixpointAnalysis<L>,
    nodeId: number,
  ): Reading<L> | undefined;
  /** Walk `this → ROOT` on per-expression block-DFA facts, returning the
   *  shallowest ancestor whose per-node fact satisfies `accept`. */
  readExprFactMinimal<L>(
    topology: ProgramTopology,
    analysis: BlockFixpointAnalysis<L>,
    nodeId: number,
    accept: (value: L) => boolean,
  ): Reading<L> | undefined;
  /** Materialize a forked body for `unit` at this chain. `reading` is the
   *  witness-carrying proof of authorization (its witness must be an
   *  ancestor of, or equal to, this chain — hand-forged Readings are
   *  rejected). The fork location is `this`, not `reading.witness`: when
   *  multiple rules fire at the same chain they all mutate the same forked
   *  body. Under `ROOT_CONTEXT` the returned array IS `unit.funcAst.body`. */
  forkBody<V>(unit: Unit, reading: Reading<V>): StmtNS.Stmt[];
}

// Runtime imports for methods that reach beyond `context.ts` itself. These
// imports participate in a file-level import cycle with `chain-body-store.ts`
// (which imports `AssumptionChain` back from here). Usage is deferred to call
// time — method bodies — so module evaluation order is immaterial.
//
// Kept below the type/value exports above so the cycle doesn't affect
// top-level initialization of `ROOT_CONTEXT` / `CHAIN_PROTO`.
import { forkBodyAt } from "./chain-body-store";

const chainProto = {
  read<K, V>(this: AssumptionChain, analysis: Analysis<K, V>, key: K): V {
    return analysis.store.read(key, this);
  },
  tryRead<K, V>(this: AssumptionChain, analysis: Analysis<K, V>, key: K): V | undefined {
    return analysis.store.tryRead(key, this);
  },
  readAt<K, V>(this: AssumptionChain, analysis: Analysis<K, V>, key: K): Reading<V> {
    return { value: analysis.store.read(key, this), witness: this };
  },
  readMinimal<K, V>(
    this: AssumptionChain,
    analysis: Analysis<K, V>,
    key: K,
    accept: (value: V) => boolean,
  ): Reading<V> | undefined {
    let match: Reading<V> | undefined;
    for (let cur: AssumptionChain | undefined = this; cur !== undefined; cur = cur.parent) {
      const value = analysis.store.tryRead(key, cur);
      if (value === undefined || !accept(value)) continue;
      match = { value, witness: cur };
    }
    return match;
  },
  readExprFactAt<L>(
    this: AssumptionChain,
    topology: ProgramTopology,
    analysis: BlockFixpointAnalysis<L>,
    nodeId: number,
  ): Reading<L> | undefined {
    const block = topology.blockOfNode(nodeId);
    if (block === undefined) return undefined;
    const facts = analysis.facts.store.tryRead(block, this);
    const value = facts?.get(nodeId);
    return value === undefined ? undefined : { value, witness: this };
  },
  readExprFactMinimal<L>(
    this: AssumptionChain,
    topology: ProgramTopology,
    analysis: BlockFixpointAnalysis<L>,
    nodeId: number,
    accept: (value: L) => boolean,
  ): Reading<L> | undefined {
    const block = topology.blockOfNode(nodeId);
    if (block === undefined) return undefined;
    let match: Reading<L> | undefined;
    for (let cur: AssumptionChain | undefined = this; cur !== undefined; cur = cur.parent) {
      const value = analysis.facts.store.tryRead(block, cur)?.get(nodeId);
      if (value === undefined || !accept(value)) continue;
      match = { value, witness: cur };
    }
    return match;
  },
  forkBody<V>(
    this: AssumptionChain,
    unit: Unit,
    reading: Reading<V>,
  ): StmtNS.Stmt[] {
    // Witness must be an ancestor (or equal) of `this`. A Reading<V> produced
    // by this chain's own readMinimal / readAt can only name a witness on the
    // walk from `this` toward ROOT. This check rejects hand-forged Readings
    // (synthetic tests that construct one directly); normal paths can't trip
    // it.
    if (!hasAncestor(this, reading.witness)) {
      throw new Error(
        `[forkBody] witness is not an ancestor of this chain — a Reading from ` +
          `a different chain cannot authorize a rewrite here`,
      );
    }
    return forkBodyAt(unit, this);
  },
};

/** Shared prototype for all interned chain instances. Exported for the
 *  interner; consumers should never touch it directly. */
export const CHAIN_PROTO: object = Object.freeze(chainProto);

export const ROOT_CONTEXT: AssumptionChain = Object.freeze(
  Object.assign(Object.create(CHAIN_PROTO), {
    parent: undefined,
    assumption: undefined,
    depth: 0,
  }) as AssumptionChain,
);

export function isRoot(ctx: AssumptionChain): boolean {
  return ctx.parent === undefined;
}

/** Build a canonical child context. Equivalent calls (same `parent`, same
 *  `(narrowing, key)`, and algebra-equal value) return the same object —
 *  identity is a sound proxy for structural equality. Value dedup uses the
 *  narrowing's value-equality relation, so no per-caller equality parameter
 *  is needed.
 *
 *  Chains are stored in canonical order by `(narrowing.debugName, key)`, so
 *  adding an assumption that sorts before an existing link triggers a
 *  silent rebuild — the returned chain may not have `parent` as its literal
 *  `.parent` pointer when the sort order requires insertion mid-chain. */
export function extendContext<K, V>(
  parent: AssumptionChain,
  narrowing: AssumptionHandle<K, V>,
  key: K,
  value: V,
): AssumptionChain {
  return defaultInterner.extend(parent, narrowing, key, value);
}

/** Walk parent pointers looking for an assumption bound against
 *  `(narrowing, key)`. Returns the deepest match (closest to `ctx`).
 *  `undefined` when no ancestor carries such an assumption. */
export function findAssumption<K, V>(
  ctx: AssumptionChain,
  narrowing: AssumptionHandle<K, V>,
  key: K,
): V | undefined {
  const target = narrowing as AssumptionHandle<unknown, unknown>;
  for (let cur: AssumptionChain | undefined = ctx; cur !== undefined; cur = cur.parent) {
    const a = cur.assumption;
    if (a !== undefined && a.narrowing === target && a.key === key) {
      return a.value as V;
    }
  }
  return undefined;
}

/** `anc` is an ancestor of `ctx` (or equal). O(depth). */
export function hasAncestor(ctx: AssumptionChain, anc: AssumptionChain): boolean {
  for (let cur: AssumptionChain | undefined = ctx; cur !== undefined; cur = cur.parent) {
    if (cur === anc) return true;
  }
  return false;
}

/** Return a context derived from `ctx` with every assumption at
 *  `(narrowing, key)` removed. Identity-returns `ctx` unchanged when no
 *  link matched — callers can short-circuit on reference equality. The
 *  canonical invariant guarantees at most one match (collisions at the
 *  same `(narrowing, key)` are replaced at extend-time, not layered), so
 *  "every" is 0 or 1 in practice — the wording is preserved for the
 *  historical contract. The returned chain is canonical; a prune that
 *  leaves a subset any prior compilation was built under returns the `===`
 *  pre-built sibling. */
export function excludeAssumption<K, V>(
  ctx: AssumptionChain,
  narrowing: AssumptionHandle<K, V>,
  key: K,
): AssumptionChain {
  return defaultInterner.exclude(ctx, narrowing, key);
}
