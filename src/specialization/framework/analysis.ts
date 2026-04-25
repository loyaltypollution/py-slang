import type { AssumptionChain, NarrowingId } from "../assumption/chain";
import type { NodeId, NodeSet } from "../program/node-set";
import { AnalysisStore, type ReadonlyAnalysisStore } from "./analysis-store";
import type { Worklist } from "./worklist";

export type { NodeId, NodeSet } from "../program/node-set";

/** Algebra over one stored value space `V`. Drives `AnalysisStore`:
 *  `bottom` is the unwritten-cell default, `join` is storage combine,
 *  `eq` gates change detection. `leq` is the partial order (a ⊑ b). */
export interface JoinSemiLattice<V> {
  readonly bottom: V;
  leq(a: V, b: V): boolean;
  join(a: V, b: V): V;
  eq(a: V, b: V): boolean;
}

/** Bounded lattice: adds `top` and `meet`. Required by DFA value-lattices:
 *  `meet` is the dual merge for "must" analyses; `top` seeds widened slots. */
export interface Lattice<V> extends JoinSemiLattice<V> {
  readonly top: V;
  meet(a: V, b: V): V;
}

/** A computation over per-analysis fact cells. `K` is the key space — must
 *  be a `NodeSet` so the worklist can route delta-bearing writes by node-id
 *  intersection. Concrete shapes: `BasicBlock` (per-block), `Function`
 *  (per-function); singleton wrappers via `internSingletonNode` for per-node.
 *  `V` is the stored cell domain. `transfer` returning `undefined` means "no
 *  write". */
export interface Analysis<K extends NodeSet, V> {
  readonly storeAlgebra: JoinSemiLattice<V>;
  /** Optional explicit value for an unwritten cell. Falls back to
   *  `storeAlgebra.bottom`. */
  readonly emptyValue?: V;
  /** Read-only cell surface. All outside-transfer queries go through `.store`;
   *  transfer-time reads go through `ctx` for dependency tracking. Internal
   *  mutation goes through helpers in `analysis-store.ts` so listener fan-out
   *  stays centralized. */
  readonly store: ReadonlyAnalysisStore<K, V>;
  /** Priority tier: runtime observations settle before analyses. Mandatory —
   *  no implicit default, to catch priority-sensitive miscompiles. */
  readonly tier: "runtime" | "analysis";
  /** Merge polarity: `"may"` = widening / over-approximate;
   *  `"must"` = intersecting / requirement-style. */
  readonly polarity: "may" | "must";
  /** Compute the next stored value at `key` under `ctx.currentContext`.
   *  Return `undefined` for "no write"; the worklist writes the returned
   *  value into `this.store` on the caller's behalf. */
  transfer(ctx: AnalysisCtx, key: K): V | undefined;

  /** Optional registration hook. Called by `Worklist.register`. */
  bind?(worklist: Worklist): void;
}

/** Pair of (analysis, seed-key) re-enqueued at every narrowing-entry to
 *  re-seed Kildall under a freshly extended/pruned context. The seed receives
 *  the `view` (a `NodeSet` — today always a `FunctionView`, but the type does
 *  not commit to that) and produces an analysis-specific key to enqueue.
 *  Structurally satisfied by `BlockFixpointAnalysis` (`.env` + `.seed(view)`). */
export interface EntrySeed {
  readonly env: Analysis<any, any>;
  seed(view: NodeSet): unknown;
}

/** Typed axis for extending an `AssumptionChain`. Carries no lattice or
 *  store of its own — only the identity used to look up chain bindings at
 *  transfer time via the paired `blockAnalysis()`. Observation glue lives
 *  in `ObservationBinding`. */
export interface Narrowing<K = any, V = unknown> extends NarrowingId<K, V> {
  readonly blockAnalysis: () => EntrySeed;
}

/** Generic transfer-time context. The framework knows about: chain-walking
 *  reads, writes (with optional delta), and evictions. It knows nothing
 *  about Functions, BasicBlocks, or any specific view kind.
 *
 *  Worklist runtime hands transfers a ctx that ALSO carries program-shape
 *  accessors (function-view-manager methods); analyses that need those cast
 *  the ctx via `asProgramCtx` from `program/program-ctx.ts`. The cast is
 *  the boundary: framework's vocabulary stops at `AnalysisCtx`. */
export interface AnalysisCtx {
  readonly currentContext: AssumptionChain;
  read<K extends NodeSet, V>(analysis: Analysis<K, V>, key: K): V;
  tryRead<K extends NodeSet, V>(analysis: Analysis<K, V>, key: K): V | undefined;
  readAll<K extends NodeSet, V>(analysis: Analysis<K, V>): ReadonlyMap<K, V>;
  /** Chain-walking read: shallowest ancestor with a hit satisfying `accept`,
   *  or `undefined`. Records a per-(analysis, key) read edge so the worklist
   *  re-enqueues this transfer when the cell at `key` advances in any
   *  context. Use instead of `analysis.store.readMinimal` from inside a
   *  transfer. */
  readMinimal<K extends NodeSet, V>(
    analysis: Analysis<K, V>,
    key: K,
    accept: (value: V) => boolean,
  ): { value: V; witness: AssumptionChain } | undefined;
  /** Chain-walking read: deepest ancestor with any hit. Same edge-recording
   *  contract as `readMinimal`. */
  readDeepest<K extends NodeSet, V>(
    analysis: Analysis<K, V>,
    key: K,
  ): { value: V; witness: AssumptionChain } | undefined;
  /** Write at `currentContext` and publish a `FactChange`. Use this for
   *  paired-cell side-effect writes (e.g. DFA `.facts` from inside `.env`'s
   *  transfer) — bypassing would skip listener fan-out. Transfer return
   *  values are dispatched automatically. Returns `true` iff the cell
   *  advanced.
   *
   *  `delta` is an optional `NodeSet` describing the nodeIds whose contribution
   *  to `value` advanced relative to the prior cell. Producers that can compute
   *  a narrower delta cheaply should pass it; otherwise the dispatcher uses
   *  `key` itself as the delta (every key extends `NodeSet`, and an advance at
   *  K naturally covers K's nodes). Readers registered via `onFactDirtyNodeSet`
   *  fire iff `intersects(interest, delta)`. */
  write<K extends NodeSet, V>(analysis: Analysis<K, V>, key: K, value: V, delta?: NodeSet): boolean;
  /** Evict at `currentContext`. */
  evict<K extends NodeSet, V>(analysis: Analysis<K, V>, key: K): void;
}

/** Imperative AST sweep gated on analyses. No lattice, no transfer, no
 *  store write. The worklist dirties a rule on view mint/rebuild and on
 *  writes to subscribed analyses; `sweep` runs once per dirty view; views
 *  that rewrote are scheduled for rebuild. Idempotency across rebuilds is
 *  the rule's responsibility.
 *
 *  Generic over `V` (view) and `P` (program-wide handle) so the framework
 *  type doesn't commit to view kind. Today's transforms instantiate as
 *  `TransformRule<Function, FunctionView>`; the framework treats them as
 *  `TransformRule<unknown, unknown>` and the worklist's sweep loop casts
 *  to the concrete pair when invoking. */
export interface TransformRule<V = unknown, P = unknown> {
  /** Returns `true` iff the body at `chain` was mutated — the worklist
   *  then schedules a rebuild for `view`. Worklist always passes
   *  `chain = futureDispatchChainFor(view)`. */
  sweep(
    view: V,
    chain: AssumptionChain,
    program: P,
  ): boolean;
  bind?(worklist: Worklist): void;
}

/** Construct an Analysis, auto-attaching its `store` from `storeAlgebra`
 *  and `emptyValue`. */
export function defineAnalysis<
  K extends NodeSet,
  V,
  P extends Analysis<K, V>["polarity"],
>(
  spec: Omit<Analysis<K, V>, "store" | "polarity"> & { polarity: P },
): Analysis<K, V> & { polarity: P } {
  const store = new AnalysisStore<K, V>(spec.storeAlgebra, spec.emptyValue);
  return { ...spec, store };
}
