import type { AssumptionChain, NarrowingId } from "../assumption/chain";
import type { NodeId, NodeSet } from "../program/node-set";
import { AnalysisStore, type ReadonlyAnalysisStore } from "./analysis-store";
import type { Worklist } from "./worklist";
import type { Function } from "../program/units/function/function";
import type { FunctionLocator } from "../program/units/function/manager";
import type { CounterStore } from "../observation/counter-store";

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

/** A computation over per-analysis fact cells. `K` is the key space — must
 *  extend `NodeSet` so the worklist can route delta-bearing writes by node-id
 *  intersection. `V` is the stored cell domain. `transfer` returning
 *  `undefined` means "no write". */
export interface Analysis<K extends NodeSet, V> {
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
  bind?(worklist: Worklist<any, any>): void;
}

/** Pair of (analysis, seed-key) re-enqueued at every narrowing-entry to
 *  re-seed Kildall under a freshly extended/pruned context. Structurally
 *  satisfied by `BlockFixpointAnalysis` (`.env` + `.seed(view)`).
 *
 *  `seed(view)` is the **reseed frontier** of a unit: the analysis-key the
 *  worklist re-enqueues when chain change reseeds Kildall for that unit.
 *  For `Function` today this is the entry CFG block. Any unit kind that
 *  participates in observation-driven chain change must satisfy
 *  `V extends NodeSet` so `seed(unit)` is well-defined; a unit kind whose
 *  reseed frontier differs from "entry block" supplies a different
 *  EntrySeed implementation rather than a special-case worklist branch. */
export interface EntrySeed<K extends NodeSet = NodeSet, V extends NodeSet = NodeSet> {
  readonly env: Analysis<K, any>;
  seed(view: V): K;
}

/** Typed axis for extending an `AssumptionChain`. Carries no lattice or
 *  store of its own; `blockAnalysis()` names the paired entry-seed re-run
 *  on every narrowing. */
export interface Narrowing<K = any, V = unknown> extends NarrowingId<K, V> {
  readonly blockAnalysis: () => EntrySeed;
}

/** Generic transfer-time context. The framework knows about chain-walking
 *  reads, writes (with optional delta), and evictions — nothing about
 *  program-shape nouns like `Function` or `BasicBlock`. Analyses that need
 *  program-shape lookup capture a `FunctionLocator` explicitly at `bind`
 *  time via `worklist.locate`; the ctx surface stays narrow. */
export interface AnalysisCtx {
  readonly currentContext: AssumptionChain;
  read<K extends NodeSet, V>(analysis: Analysis<K, V>, key: K): V;
  tryRead<K extends NodeSet, V>(analysis: Analysis<K, V>, key: K): V | undefined;
  readAll<K extends NodeSet, V>(analysis: Analysis<K, V>): ReadonlyMap<K, V>;
  /** Chain-walking read: shallowest ancestor with a hit satisfying `accept`,
   *  or `undefined`. Records a per-(analysis, key) read edge. */
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
  /** Write at `currentContext` and publish a `FactChange`. Returns `true`
   *  iff the cell advanced. `delta` (a `NodeSet`) scopes node-intersection
   *  subscribers; defaults to `key`. */
  write<K extends NodeSet, V>(analysis: Analysis<K, V>, key: K, value: V, delta?: NodeSet): boolean;
  /** Evict at `currentContext`. */
  evict<K extends NodeSet, V>(analysis: Analysis<K, V>, key: K): void;
}

/** Narrow capability surface offered to a `TransformRule.bind`. Lets a
 *  transform register dirtying subscriptions and refute hooks without
 *  receiving the full `Worklist` (and the read/write powers that come
 *  with it).
 *
 *  Generic over `(U, L)` — the same unit kind / locator the owning
 *  worklist dispatches over. Defaults to `(Function, FunctionLocator)`
 *  so existing call sites compile unchanged. */
export interface TransformBindCtx<U = Function, L = FunctionLocator> {
  onTransformFactDirty<K extends NodeSet>(
    rule: TransformRule<U, L>,
    from: Analysis<K, any>,
    dirtied: (locator: L, key: K) => Iterable<U>,
  ): void;
  onTransformCounterBumped<K>(
    rule: TransformRule<U, L>,
    counter: CounterStore<K>,
    dirtied: (locator: L, key: K) => Iterable<U>,
  ): void;
  onRefute(cb: (unit: U, carrier: AssumptionChain) => void): void;
}

/** Imperative AST sweep gated on analyses. No lattice, no transfer, no store
 *  write. The worklist dirties a rule on extent change (mint or rebuild) and
 *  on writes to subscribed analyses; `sweep` runs once per dirty unit; units
 *  that rewrote are scheduled for rebuild. Idempotency is the rule's
 *  responsibility.
 *
 *  Generic over `(U, L)` so a single worklist can drive transforms over
 *  any unit kind it owns; defaults to `(Function, FunctionLocator)`.
 *  Polymorphism is over **unit kinds**, not arbitrary `NodeSet` regions —
 *  blocks/loops remain subordinate `NodeSet`s unless they graduate to a
 *  full unit. */
export interface TransformRule<U = Function, L = FunctionLocator> {
  /** Returns `true` iff the body at `chain` was mutated — the worklist
   *  then schedules a rebuild for `unit`. Worklist always passes
   *  `chain = chainFor(unit)`. */
  sweep(unit: U, chain: AssumptionChain, locator: L): boolean;
  bind?(ctx: TransformBindCtx<U, L>): void;
}

/** Construct an `Analysis`, auto-attaching its `store` from `storeAlgebra`
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
