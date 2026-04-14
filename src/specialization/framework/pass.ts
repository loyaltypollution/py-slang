// Three citizen kinds are registered with a Worklist. They share a registration
// mechanism but not a shape — do not collapse them:
//
//   Pass<K, V>        — monotone lattice-keyed unit. Registered via
//                       `worklist.register`; `transfer(ctx, key)` writes into
//                       the FactStore. All fixpoint work flows through Passes.
//
//   BlockDfaSpec<L>   — descriptor (lattice + visitor factory) handed to
//                       `makeBlockFixpointPass` in `interfaces.ts`. Not
//                       registered directly; the factory produces a
//                       `Pass<BasicBlock, DfaBlockFact<L>>` that is.
//
//   TransformRule     — imperative AST sweep (defined below). Registered via
//                       `worklist.registerTransform`; no lattice, no transfer,
//                       no FactStore write. `sweep(unit, ctx)` returns `true`
//                       to trigger CFG rebuild.

import type { FunctionUnit } from "./function-unit";
import type { FactStore } from "./fact-store";

/** Value-space algebra. `leq` is the partial order (a ⊑ b). `join` is the
 *  least upper bound. `bottom` is returned for unwritten cells. Equality is
 *  always derived as `leq(a,b) && leq(b,a)` — no custom override, so the
 *  partial order is the single source of truth for change detection. */
export interface Lattice<V> {
  readonly bottom: V;
  leq(a: V, b: V): boolean;
  join(a: V, b: V): V;
}

/** Equality under the lattice's partial order, derived from `leq`. */
export function latticeEquals<V>(lattice: Lattice<V>, a: V, b: V): boolean {
  return lattice.leq(a, b) && lattice.leq(b, a);
}

/** Bounded lattice: adds `top` and `meet` to `Lattice<V>`. Required by DFA
 *  value-lattices — `meet` is the dual merge for "must" analyses, and `top`
 *  seeds MutableEnv slots when the generic block transfer widens (e.g. For
 *  loop targets). Cell-level `Lattice<V>` (the `Pass.lattice` type) does not
 *  need these; counters, sticky flags, and observation lattices rarely have
 *  a natural `top` or `meet`, so we keep the base interface permissive. */
export interface BoundedLattice<V> extends Lattice<V> {
  readonly top: V;
  meet(a: V, b: V): V;
}

/** An edge into a pass. Two shapes, discriminated by the mandatory `on` tag:
 *
 *   - Fact edge (`on: "fact"`): `wake` projects an upstream pass's key-change
 *     to zero-or-more keys in *this* pass's key-space, enqueuing them for
 *     re-transfer. Both `on` and `wake` are required — "depends on, doesn't
 *     react" is not an auto-reactive edge; express such dependencies by
 *     reading from `factStore.read(upstream, ...)` in `transfer` without declaring
 *     an edge.
 *
 *   - Lifecycle edge (`on: "mint" | "rebuild" | "retire"`): fires on unit
 *     lifecycle transitions. `wake(ctx, unit)` yields keys to enqueue;
 *     `effect(ctx, unit)` runs arbitrary side effects (typically
 *     `factStore.evict` for passes with unit-scoped facts). At least one of
 *     `wake` / `effect` must be defined.
 *
 *  `on` is mandatory on both shapes so discriminated narrowing in consumers
 *  (worklist.ts's subscribe loop) works without a cast. Construction-site
 *  cost is one extra `on: "fact"` field per edge literal — acceptable for
 *  the guarantee that the union narrowing actually refines. */
export type EdgeSpec<K> = FactEdge<K> | LifecycleEdge<K>;

export interface FactEdge<K> {
  readonly on: "fact";
  readonly pass: Pass<any, any>;
  wake(ctx: PassCtx, key: unknown): Iterable<K>;
}

export interface LifecycleEdge<K> {
  readonly on: "mint" | "rebuild" | "retire";
  wake?(ctx: PassCtx, unit: FunctionUnit): Iterable<K>;
  effect?(factStore: FactStore, ctx: PassCtx, unit: FunctionUnit): void;
}

/** Module-level set of passes the Worklist has registered. Populated by
 *  `Worklist.register`; consulted by `addEdge` to reject amendments that
 *  would be silently dropped by the worklist's edge-snapshot. Using a
 *  `WeakSet` means the bookkeeping lives off-object (no structural stamp
 *  on `Pass`) and retired-but-unreferenced passes are collectible. */
export const REGISTERED_PASSES: WeakSet<Pass<any, any>> = new WeakSet();

/** Append an `EdgeSpec` to a pass's `edges` after construction. Encapsulates
 *  the readonly-cast that would otherwise leak at every call site. Intended
 *  for passes with mutually-recursive edges that can't be declared at
 *  literal-construction time (e.g. purity block ↔ scope). Throws if `pass`
 *  is already registered with a worklist — the worklist snapshots `edges`
 *  during `register`, so post-registration additions would silently never
 *  dispatch. */
export function addEdge<K>(pass: Pass<K, any>, spec: EdgeSpec<K>): void {
  if (REGISTERED_PASSES.has(pass as Pass<any, any>)) {
    throw new Error(
      `[addEdge] pass "${pass.debugName}" is already registered with a worklist; edges added now will never dispatch. Declare edges at construction or via addEdge before register().`,
    );
  }
  (pass.edges as EdgeSpec<K>[]).push(spec);
}

/** A computation over the fact store. `transfer` returning `undefined` means "no write".
 *  `factStore` is passed explicitly so the only reads/writes a pass can perform
 *  go through an identified parameter — PassCtx carries unit-topology lookups
 *  only, not a backdoor to the store. */
export interface Pass<K, V> {
  readonly id: symbol;
  readonly debugName: string;
  readonly lattice: Lattice<V>;
  readonly edges: ReadonlyArray<EdgeSpec<K>>;
  /** Priority tier. Runtime observations settle before analyses within a
   *  `processQueue` drain. Transforms are no longer passes — see
   *  `TransformRule`. Mandatory: a forgotten tier used to silently default
   *  to `"analysis"`, which was a miscompile vector for any future
   *  priority-sensitive consumer. */
  readonly tier: "runtime" | "analysis";
  transfer(factStore: FactStore, ctx: PassCtx, key: K): V | undefined;
}

/** Unit-topology view handed to transfers / effects / sweeps alongside the
 *  `FactStore`. Intentionally narrow: the store is the only read/write path,
 *  and it is always passed as its own parameter so calls like
 *  `ctx.factStore.evict(...)` can't slip through. */
export interface PassCtx {
  /** Outermost containing unit for a node. */
  unitForNode(nodeId: number): FunctionUnit | undefined;
  /** Unit for a `FunctionDef.id`. */
  unitForFdId(fdId: number): FunctionUnit | undefined;
}

/** One-shot or cascading imperative AST sweep gated on analyses. Transforms
 *  are not `Pass<_, _>` — they have no lattice, no transfer, and do not
 *  participate in the fact-store fixpoint. Worklist dirties a rule on unit
 *  mint / rebuild and on writes to any pass declared in `edges`; the rule's
 *  `sweep` runs once per dirty unit after `processQueue` drains, and units
 *  that rewrote are scheduled for CFG rebuild. Idempotency across rebuilds
 *  is the rule's responsibility: dead-branch / const-folding are naturally
 *  idempotent (rewriting removes the precondition); memoization must track
 *  its own wrapped-set. */
export interface TransformRule {
  readonly id: symbol;
  readonly debugName: string;
  /** Fact-driven wake edges — reuses `FactEdge<FunctionUnit>` so transform
   *  and pass edges go through the same dispatch shape. A write to the
   *  edge's `pass` calls `wake(ctx, key)`, which yields the units to add to
   *  this rule's dirty set. Omit for a rule that only fires on mint/rebuild. */
  readonly edges?: ReadonlyArray<FactEdge<FunctionUnit>>;
  /** Lifecycle events that auto-dirty every unit. Defaults to both `"mint"`
   *  and `"rebuild"` — the historical behavior. Rules that drive dirtying
   *  purely from fact edges can opt out with `[]`. Explicit so the
   *  mint/rebuild auto-dirty is visible in the type rather than hidden
   *  inside `Worklist.registerTransform`. */
  readonly autoDirtyOn?: ReadonlyArray<"mint" | "rebuild">;
  /** Returns `true` iff `unit.body` was mutated — the worklist then schedules
   *  a CFG rebuild for `unit`. */
  sweep(unit: FunctionUnit, factStore: FactStore, ctx: PassCtx): boolean;
}
