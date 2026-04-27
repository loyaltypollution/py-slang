import type { AssumptionChain, NarrowingAxis } from "../assumption/chain";
import type { SaturatingCounter } from "../observation/counter-store";
import type { ObservationSource } from "../observation/observation-channel";
import type { Function } from "../program/function/function";
import type { FunctionLocator } from "../program/function/manager";
import type { NodeId, NodeSet } from "../program/node-set";
import { AnalysisStore, type ReadonlyAnalysisStore } from "./analysis-store";

export type { NodeId, NodeSet } from "../program/node-set";

/** Algebra over one stored value space `V`. `bottom` is the unwritten-cell
 *  default; `join` is storage combine; `eq` gates change detection;
 *  `leq` is the partial order (a ⊑ b). */
export interface JoinSemiLattice<V> {
  readonly bottom: V;
  leq(a: V, b: V): boolean;
  join(a: V, b: V): V;
  eq(a: V, b: V): boolean;
}

/** Bounded lattice: adds `top` and `meet` for must-style merges and widened
 *  seeds. */
export interface Lattice<V> extends JoinSemiLattice<V> {
  readonly top: V;
  meet(a: V, b: V): V;
}

/** A computation over per-analysis fact cells. `K` is the key space (opaque
 *  to the framework — bus routing is per-subscription, not per-key). `V` is
 *  the stored cell domain. `transfer` returning `undefined` means "no write". */
export interface Analysis<K, V> {
  readonly storeAlgebra: JoinSemiLattice<V>;
  /** Override for the unwritten-cell default. Falls back to
   *  `storeAlgebra.bottom`. */
  readonly emptyValue?: V;
  /** Read-only cell surface. Outside-transfer queries go here; transfer-time
   *  reads go through `ctx` for read-edge tracking. */
  readonly store: ReadonlyAnalysisStore<K, V>;
  /** Priority tier: runtime-tier triples preempt analysis-tier triples,
   *  FIFO within tier. */
  readonly tier: "runtime" | "analysis";
  /** Merge polarity: `"may"` = widening / over-approximate;
   *  `"must"` = intersecting / requirement-style. */
  readonly polarity: "may" | "must";
  /** Compute the next stored value at `key` under `ctx.currentContext`.
   *  Return `undefined` for "no write"; otherwise the worklist combines and
   *  publishes the value. */
  transfer(ctx: AnalysisCtx, key: K): V | undefined;

  /** Optional registration hook. Called by `Worklist.register`. */
  bind?(ctx: AnalysisBindCtx): void;
}

/** Narrow capability surface offered to an `Analysis.bind`. Lets an analysis
 *  register lifecycle / fact-routing subscriptions without receiving the full
 *  `Worklist` (and the read/write/observe powers that come with it).
 *
 *  `onExtentChange` always carries the `isMint` flag; the worklist's own
 *  `onExtentChange` convenience that drops the flag is internal. */
export interface AnalysisBindCtx {
  /** Subscribe to mint and rebuild on any unit. `isMint` is `true` for the
   *  subscribe-time replay of every existing unit, `false` for rebuilds. */
  onExtentChange(cb: (unit: Function, isMint: boolean) => void): void;
  /** Enqueue `(analysis, key)` at `ROOT_CONTEXT`. Lifecycle hooks
   *  (e.g. extent-change handlers that need to seed work) call this to
   *  schedule a transfer without reaching for the full worklist. */
  enqueue<K>(analysis: Analysis<K, any>, key: K): void;
  /** Subscribe `reader` to chain changes on any unit's preferred future-
   *  dispatch chain. Re-enqueues at `ROOT_CONTEXT`. */
  onChainChange<K>(
    reader: Analysis<K, any>,
    dirtied: (locator: FunctionLocator, unit: Function) => Iterable<K>,
  ): void;
  /** Subscribe `reader` to advancing writes on `from` whose published node
   *  delta intersects `interest`. */
  subscribe<K>(
    from: Analysis<any, any>,
    reader: Analysis<K, any>,
    interest: NodeSet,
    dirtied: (locator: FunctionLocator, key: unknown) => Iterable<K>,
  ): void;
  /** Subscribe `reader` to every advancing write on `from`, regardless of
   *  node delta. Cell-identity dependency, not node-membership. */
  subscribeOnAdvance<K>(
    from: Analysis<any, any>,
    reader: Analysis<K, any>,
    dirtied: (locator: FunctionLocator, key: unknown) => Iterable<K>,
  ): void;
}

/** Pair of (analysis, seed-key) re-enqueued at every narrowing-entry to
 *  re-seed Kildall under a freshly extended/pruned context. Structurally
 *  satisfied by `BlockFixpointAnalysis` (`.env` + `.seed(view)`).
 *
 *  `seed(view)` is the **reseed frontier** of a unit: the analysis-key the
 *  worklist re-enqueues when chain change reseeds Kildall for that unit.
 *  For `Function` today this is the entry CFG block. A unit kind whose
 *  reseed frontier differs from "entry block" supplies a different
 *  EntrySeed implementation rather than a special-case worklist branch. */
export interface EntrySeed<K = unknown, V = Function> {
  readonly env: Analysis<K, any>;
  seed(view: V): K;
}

/** Production narrowing dimension. Extends the algebra-only `NarrowingAxis`
 *  with the worklist's reseed hook (`blockAnalysis`) and the observation
 *  glue (`source` + `lift` + `resolveUnit`).
 *
 *  Locator and unit types are loose here; concrete axes type their
 *  `resolveUnit` lambda explicitly, and the worklist casts at the ingress
 *  seam (one cast at registration, not per observation). */
export interface Narrowing<K = any, V = unknown, O = unknown> extends NarrowingAxis<K, V> {
  readonly blockAnalysis: () => EntrySeed;
  readonly source: ObservationSource<K, O>;
  /** `undefined` = observation doesn't map (skip without refuting). */
  lift(observed: O): V | undefined;
  resolveUnit(locator: FunctionLocator, key: K): Function | undefined;
}

/** Generic transfer-time context. The framework knows about chain-walking
 *  reads, writes (with optional delta), evictions, and the program-shape
 *  read surface (`locator`). Anything richer than `FunctionLocator` (e.g.
 *  scheduling, chain mutation) stays off the ctx and on the `Worklist`. */
export interface AnalysisCtx {
  readonly currentContext: AssumptionChain;
  /** Program-shape read surface: by-FunctionId / by-NodeId / blockContaining.
   *  Plumbed by the worklist so transfers don't reimplement bind-time
   *  capture against a mutable `let`. */
  readonly locator: FunctionLocator;
  read<K, V>(analysis: Analysis<K, V>, key: K): V;
  tryRead<K, V>(analysis: Analysis<K, V>, key: K): V | undefined;
  readAll<K, V>(analysis: Analysis<K, V>): ReadonlyMap<K, V>;
  /** Chain-walking read: shallowest ancestor with a hit satisfying `accept`,
   *  or `undefined`. Records a per-(analysis, key) read edge. */
  readMinimal<K, V>(
    analysis: Analysis<K, V>,
    key: K,
    accept: (value: V) => boolean,
  ): { value: V; witness: AssumptionChain } | undefined;
  /** Chain-walking read: deepest ancestor with any hit. Same edge-recording
   *  contract as `readMinimal`. */
  readDeepest<K, V>(
    analysis: Analysis<K, V>,
    key: K,
  ): { value: V; witness: AssumptionChain } | undefined;
  /** Write at `currentContext` and publish a `FactChange`. Returns `true`
   *  iff the cell advanced. `delta` (a `NodeSet`) scopes node-intersection
   *  subscribers; required when this analysis has any `subscribe()` reader,
   *  forbidden via the absence of subscribers otherwise (no implicit
   *  default — the worklist throws on a NodeSet-routed write with no delta). */
  write<K, V>(analysis: Analysis<K, V>, key: K, value: V, delta?: NodeSet): boolean;
  /** Evict at `currentContext`. */
  evict<K, V>(analysis: Analysis<K, V>, key: K): void;
}

export interface TransformResult {
  readonly changed: boolean;
  readonly canonicalChanged: boolean;
  readonly touchedWitnesses: readonly AssumptionChain[];
}

/** Narrow capability surface offered to a `TransformRule.bind`. Lets a
 *  transform register dirtying subscriptions and refute hooks without
 *  receiving the full `Worklist` (and the read/write powers that come
 *  with it). */
export interface TransformBindCtx {
  onTransformFactDirty<K>(
    rule: TransformRule,
    from: Analysis<K, any>,
    dirtied: (locator: FunctionLocator, key: K) => Iterable<Function>,
  ): void;
  onPolicyCounterAdvance<K>(
    rule: TransformRule,
    counter: SaturatingCounter<K>,
    dirtied: (locator: FunctionLocator, key: K) => Iterable<Function>,
  ): void;
  onRefute(cb: (unit: Function, carrier: AssumptionChain) => void): void;
}

/** Imperative AST sweep gated on analyses. No lattice, no transfer, no store
 *  write. The worklist dirties a rule on extent change (mint or rebuild) and
 *  on writes to subscribed analyses; `sweep` runs once per dirty unit.
 *
 *  `TransformResult` distinguishes canonical-body mutation from speculative
 *  variant mutation. Only canonical mutation requires CFG rebuild. Variant
 *  sweeps may also update cached speculative bodies; those rules are
 *  responsible for keeping descendant caches coherent while they rewrite. */
export interface TransformRule {
  /** Returns the structural effect of one sweep at `chain = chainFor(unit)`.
   *  `canonicalChanged` means `unit` needs a rebuild; `touchedWitnesses`
   *  record which speculative ancestors were rewritten. */
  sweep(unit: Function, chain: AssumptionChain, locator: FunctionLocator): TransformResult;
  bind?(ctx: TransformBindCtx): void;
}

/** Construct an `Analysis`, auto-attaching its `store` from `storeAlgebra`
 *  and `emptyValue`. */
export function defineAnalysis<K, V, P extends Analysis<K, V>["polarity"]>(
  spec: Omit<Analysis<K, V>, "store" | "polarity"> & { polarity: P },
): Analysis<K, V> & { polarity: P } {
  const store = new AnalysisStore<K, V>(spec.storeAlgebra, spec.emptyValue);
  return { ...spec, store };
}
