import type { AssumptionChain, NarrowingAxis } from "../assumption/chain";
import type { SaturatingCounter } from "../observation/counter-store";
import type { ObservationSource } from "../observation/observation-channel";
import type { Function } from "../program/units/function/function";
import type { FunctionLocator } from "../program/units/function/manager";
import type { NodeId, NodeSet } from "../program/node-set";
import { AnalysisStore, type ReadonlyAnalysisStore } from "./analysis-store";
import type { Worklist } from "./worklist";

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

/** Production narrowing dimension. Extends the algebra-only `NarrowingAxis`
 *  with the worklist's reseed hook (`blockAnalysis`) and the optional
 *  observation glue (`source` + `lift` + `resolveUnit`).
 *
 *  Test/synthetic axes that don't drive observation can satisfy this with
 *  `source`/`lift`/`resolveUnit` omitted. The worklist only routes ingress
 *  for axes that supply a `source`.
 *
 *  Locator and unit types are loose here; concrete axes type their
 *  `resolveUnit` lambda explicitly, and the worklist casts at the ingress
 *  seam (one cast at registration, not per observation). */
export interface Narrowing<K = any, V = unknown, O = unknown> extends NarrowingAxis<K, V> {
  readonly blockAnalysis: () => EntrySeed;
  readonly source?: ObservationSource<K, O>;
  /** `undefined` = observation doesn't map (skip without refuting). */
  lift?(observed: O): V | undefined;
  /** Defaults at the worklist to `(loc, key) => loc.unitContainingNode(key)`
   *  when omitted — i.e. the observation key is treated as a NodeId. */
  resolveUnit?(locator: any, key: K): unknown;
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

export interface TransformResult {
  readonly changed: boolean;
  readonly canonicalChanged: boolean;
  readonly touchedWitnesses: readonly AssumptionChain[];
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
  onPolicyCounterAdvance<K>(
    rule: TransformRule<U, L>,
    counter: SaturatingCounter<K>,
    dirtied: (locator: L, key: K) => Iterable<U>,
  ): void;
  onRefute(cb: (unit: U, carrier: AssumptionChain) => void): void;
}

/** Imperative AST sweep gated on analyses. No lattice, no transfer, no store
 *  write. The worklist dirties a rule on extent change (mint or rebuild) and
 *  on writes to subscribed analyses; `sweep` runs once per dirty unit.
 *
 *  `TransformResult` distinguishes canonical-body mutation from speculative
 *  variant mutation. Only canonical mutation requires CFG rebuild. Variant
 *  sweeps may also update cached speculative bodies; those rules are
 *  responsible for keeping descendant caches coherent while they rewrite.
 *
 *  Generic over `(U, L)` so a single worklist can drive transforms over
 *  any unit kind it owns; defaults to `(Function, FunctionLocator)`.
 *  Polymorphism is over **unit kinds**, not arbitrary `NodeSet` regions —
 *  blocks/loops remain subordinate `NodeSet`s unless they graduate to a
 *  full unit. */
export interface TransformRule<U = Function, L = FunctionLocator> {
  /** Returns the structural effect of one sweep at `chain = chainFor(unit)`.
   *  `canonicalChanged` means `unit` needs a rebuild; `touchedWitnesses`
   *  record which speculative ancestors were rewritten. */
  sweep(unit: U, chain: AssumptionChain, locator: L): TransformResult;
  bind?(ctx: TransformBindCtx<U, L>): void;
}

/** Construct an `Analysis`, auto-attaching its `store` from `storeAlgebra`
 *  and `emptyValue`. */
export function defineAnalysis<K extends NodeSet, V, P extends Analysis<K, V>["polarity"]>(
  spec: Omit<Analysis<K, V>, "store" | "polarity"> & { polarity: P },
): Analysis<K, V> & { polarity: P } {
  const store = new AnalysisStore<K, V>(spec.storeAlgebra, spec.emptyValue);
  return { ...spec, store };
}
