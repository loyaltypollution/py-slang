// Four citizen kinds. They share nothing structurally — do not collapse them:
//
//   Analysis<K, V>        — monotone store-domain-keyed unit. Registered via
//                       `worklist.register`; `transfer(ctx, key)` returns
//                       the value to write into `this.store`. All
//                       scheduled fixpoint work flows through Analyses.
//                       Every write lands in `analysis.store` and fans
//                       out through the worklist's change-dispatch list.
//
//   BlockDfaSpec<L>   — descriptor (lattice + visitor factory) handed to
//                       `makeBlockFixpointAnalysis` in `interfaces.ts`. Not
//                       registered directly; the factory produces a
//                       `BlockFixpointAnalysis<L>` (paired `.env` + `.facts`
//                       Analyses) the worklist registers.
//
//   AssumptionHandle<K, V> — namespace token for `Context` chains. Does NOT
//                       own a `store`. No transfer, no edges, no tier, no
//                       polarity, no `storeAlgebra`. Carries just `id`,
//                       `debugName`, `keySpace?`, and `eq` — the
//                       value-equality relation the context interner uses
//                       to dedup `(handle, key, value)` triples. Handles
//                       cannot flow through the worklist's read/write
//                       surface; the type checker rejects it.
//
//   TransformRule     — imperative AST sweep (defined below). Registered via
//                       `worklist.registerTransform`; no lattice, no
//                       transfer, no store write. `sweep(unit, facts)`
//                       returns `true` to trigger CFG rebuild.

import type { Unit } from "./function-unit";
import type { Context } from "./context";
import type { RawKind } from "./raw-value";
import type { BlockFixpointAnalysis } from "./dfa-factory";
import type { ProgramTopology } from "./topology";
import { AnalysisStore } from "./analysis-store";

/** Algebra over one stored value space `V`. `AnalysisStore` uses this
 *  surface for three store-level jobs: default value for unwritten
 *  `read(...)`, storage combine in `write(...)`, and equality/change
 *  detection.
 *
 *  For some analyses, `V` is also the semantic fact domain the transfer
 *  reasons about directly (runtime observations, scope summaries). For
 *  others, especially block DFAs, `V` is a lifted stored-cell domain like
 *  the paired `.env`/`.facts` cells of a block DFA built from an inner
 *  semantic domain `L`. That is why the framework comment says
 *  `Value-space algebra`, not `the program lattice`.
 *
 *  `leq` is the partial order (a ⊑ b); `join` is the combine exposed on
 *  this stored domain; `bottom` is what `AnalysisStore.read` returns for
 *  an unwritten cell. `eq` is structural equality — typically the
 *  antisymmetric closure of `leq`, though callers may provide a faster
 *  equivalent implementation. */
export interface Lattice<V> {
  readonly bottom: V;
  leq(a: V, b: V): boolean;
  join(a: V, b: V): V;
  eq(a: V, b: V): boolean;
}

/** Bounded lattice: adds `top` and `meet` to `Lattice<V>`. Required by DFA
 *  value-lattices — `meet` is the dual merge for "must" analyses, and `top`
 *  seeds MutableEnv slots when the generic block transfer widens (e.g. For
 *  loop targets). Cell-level base algebras over stored domains rarely need
 *  these; counters, sticky flags, and observation lattices often have no
 *  natural `top`/`meet`, so we keep the base interface permissive. */
export interface BoundedLattice<V> extends Lattice<V> {
  readonly top: V;
  meet(a: V, b: V): V;
}

/** Named alias for the algebra over an analysis's stored cell domain.
 *
 *  This is the surface `AnalysisStore` consumes. For plain analyses it is
 *  often the same object as the semantic lattice; for lifted analyses it
 *  is the outer/store algebra over the stored summary domain. Keeping a
 *  separate name makes that role explicit even when the runtime shape is
 *  still `Lattice<V>`. */
export interface StoreAlgebra<V> extends Lattice<V> {}

/** An edge into an analysis. Two shapes, discriminated by the mandatory `on` tag:
 *
 *   - Fact edge (`on: "fact"`): `wake` projects an upstream analysis's key-change
 *     to zero-or-more keys in *this* analysis's key-space, enqueuing them for
 *     re-transfer. Both `on` and `wake` are required — "depends on, doesn't
 *     react" is not an auto-reactive edge; express such dependencies by
 *     reading from `ctx.read(upstream, ...)` in `transfer` without declaring
 *     an edge.
 *
 *   - Lifecycle edge (`on: "mint" | "rebuild" | "retire" | "specContextChange"`):
 *     fires on unit lifecycle transitions or spec-context mutations.
 *     `wake(ctx, unit)` yields keys to enqueue; `effect(ctx, unit)` runs
 *     arbitrary side effects (typically `ctx.evict(analysis, key)` for
 *     analyses with unit-scoped facts). At least one of `wake` / `effect`
 *     must be defined.
 *
 *  `on` is mandatory on both shapes so discriminated narrowing in consumers
 *  (worklist.ts's subscribe loop) works without a cast. Construction-site
 *  cost is one extra `on: "fact"` field per edge literal — acceptable for
 *  the guarantee that the union narrowing actually refines. */
export type EdgeSpec<K> = FactEdge<K> | LifecycleEdge<K>;

export interface FactEdge<K> {
  readonly on: "fact";
  readonly analysis: Analysis<any, any>;
  wake(ctx: AnalysisCtx, key: unknown): Iterable<K>;
  /** Optional side effect fired before `wake`'s keys are enqueued. Used by
   *  the speculative DFA analyses to evict block-cell caches when an upstream
   *  observation changes: narrowing fixpoints don't converge monotonically
   *  through loops (a back-edge carrying a stale widened fact absorbs the
   *  narrowing from the entry block), so we restart from a clean slate.
   *
   *  Writes/evicts go directly through `someAnalysis.store.evict(key, ctx.currentContext)`
   *  or similar. Reads use `ctx.read(analysis, key)` etc. */
  effect?(ctx: AnalysisCtx, key: unknown): void;
  /** Which context the woken keys should be enqueued under.
   *   - `"same-context"` (default): enqueue at `ctx.currentContext`, i.e. the
   *     context the upstream write happened in. Ripple stays in-context.
   *   - `"root"`: enqueue at ROOT regardless of the source context. Used by
   *     context-blind consumers (e.g. the SVML JIT recompile analysis) whose
   *     fact cells exist only at ROOT — waking them in a non-ROOT context
   *     would write into an orphan cell no one ever reads. */
  readonly contextPolicy?: "same-context" | "root";
}

export interface LifecycleEdge<K> {
  /** Event kinds:
   *   - `mint` / `rebuild` / `retire` — unit-lifecycle transitions.
   *   - `specContextChange` — the owning unit's active speculation context
   *     (`Worklist.specContextFor`) has changed. Fires on observation-driven
   *     extend, on lineage-precise widen (`Worklist.widenGuard`), and on
   *     whole-unit widen (`Worklist.widenUnitSpeculation`). A pure context
   *     reset advances no facts, so fact-edge subscribers don't wake on their
   *     own — analyses whose output depends on `specContextFor(unit)` (e.g.
   *     backend JIT recompile) subscribe here so deopt handlers don't have to
   *     enqueue them manually. */
  readonly on: "mint" | "rebuild" | "retire" | "specContextChange";
  wake?(ctx: AnalysisCtx, unit: Unit): Iterable<K>;
  effect?(ctx: AnalysisCtx, unit: Unit): void;
}

/** Module-level set of analyses the Worklist has registered. Populated by
 *  `Worklist.register`; consulted by `addEdge` to reject amendments that
 *  would be silently dropped by the worklist's edge-snapshot. Using a
 *  `WeakSet` means the bookkeeping lives off-object (no structural stamp
 *  on `Analysis`) and retired-but-unreferenced analyses are collectible. */
export const REGISTERED_ANALYSES: WeakSet<Analysis<any, any>> = new WeakSet();

/** Append an `EdgeSpec` to an analysis's `edges` after construction. Encapsulates
 *  the readonly-cast that would otherwise leak at every call site. Intended
 *  for analyses with mutually-recursive edges that can't be declared at
 *  literal-construction time (e.g. purity block ↔ scope). Throws if `analysis`
 *  is already registered with a worklist — the worklist snapshots `edges`
 *  during `register`, so post-registration additions would silently never
 *  dispatch. */
export function addEdge<K>(analysis: Analysis<K, any>, spec: EdgeSpec<K>): void {
  if (REGISTERED_ANALYSES.has(analysis as Analysis<any, any>)) {
    throw new Error(
      `[addEdge] analysis "${analysis.debugName}" is already registered with a worklist; edges added now will never dispatch. Declare edges at construction or via addEdge before register().`,
    );
  }
  (analysis.edges as EdgeSpec<K>[]).push(spec);
}

/** A computation over per-analysis fact cells.
 *
 *  `K` names the analysis's key space: in this codebase that is not one
 *  uniform universe but several program-derived index spaces such as node
 *  ids, function-definition ids, CFG `BasicBlock`s, and whole `Unit`s.
 *
 *  `V` names the stored cell domain for those keys. That stored domain
 *  is what `AnalysisStore` reads/writes/merges. It is sometimes the same
 *  as the analysis's semantic fact domain, and sometimes a lifted/product
 *  domain over an inner semantic space (for example a block DFA's `.env`
 *  cell storing `MutableEnv<L>` alongside its paired `.facts` cell).
 *
 *  `transfer` returning `undefined` means "no write". */
export interface Analysis<K, V> {
  readonly id: symbol;
  readonly debugName: string;
  /** Descriptive name for the program-derived index space this analysis keys
   *  by (`nodeId`, `functionId`, `BasicBlock`, ...). Documents the topology boundary;
   *  bridge logic stays explicit in projectors/lookups. */
  readonly keySpace?: string;
  /** Primary algebra over the stored cell domain `V`. Consumed by the
   *  analysis's own `store` (at construction time) and by external callers
   *  that need the algebra surface (e.g. svml-jit-analysis' snapshot-matches
   *  comparison).
   *
   *  For scheduled analyses this is the algebra over the stored cell domain
   *  `V`. */
  readonly storeAlgebra: StoreAlgebra<V>;
  /** Optional explicit value for an unwritten cell. When absent, `store.read`
   *  falls back to `storeAlgebra.bottom`.
   *
   *  This separates absent-cell semantics from the broader algebra and makes
   *  lifted/synthetic store domains state their default directly instead of
   *  relying on readers to infer it from `polarity` or semantic meaning. */
  readonly emptyValue?: V;
  /** This analysis's cells. Context-partitioned, algebra-gated. See
   *  `./analysis-store.ts`. Storage is owned by the Analysis, not by an
   *  external registry — `factStore.read(analysis, ...)` is a thin facade
   *  over `analysis.store.read(...)` and is slated for removal once every
   *  caller consumes the store directly.
   *
   *  Construction is handled by `defineAnalysis({...})` so declarations
   *  stay literal-shaped without boilerplate. */
  readonly store: AnalysisStore<K, V>;
  readonly edges: ReadonlyArray<EdgeSpec<K>>;
  /** Priority tier. Runtime observations settle before analyses within a
   *  `processQueue` drain. Transforms are no longer analyses — see
   *  `TransformRule`. Mandatory: a forgotten tier used to silently default
   *  to `"analysis"`, which was a miscompile vector for any future
   *  priority-sensitive consumer. */
  readonly tier: "runtime" | "analysis";
  /** Merge polarity. Names which of the classical DFA quadrants an analysis
   *  semantically occupies, surfaced at the Analysis level so reviewers don't
   *  need to dereference a `BlockDfaSpec` to tell:
   *
   *    - `"may"`     — widening / over-approximate merge.
   *    - `"must"`    — intersecting / requirement-style merge.
   *    - `"opaque"`  — neither a semantic may/must fact surface nor a
   *                    transform-visible refinement contract. Runtime
   *                    observations (profiler evidence, call counts) live
   *                    here — they feed policy/narrowing pipelines, not
   *                    direct transform consumers.
   *
   *  This is an interpretation contract for reviewers and consumers, not a
   *  promise that `AnalysisStore` can derive absent-cell/default semantics
   *  from polarity alone. `BlockDfaSpec` already carries `mergeKind`;
   *  polarity mirrors it for the wrapping Analysis and adds the
   *  `"opaque"` case for non-DFA analyses. */
  readonly polarity: "may" | "must" | "opaque";
  /** Optional hook invoked at every `Worklist.observe` for this analysis,
   *  BEFORE the fact-store write. Fires once per observe call, including
   *  repeats the fact store may collapse — appropriate for
   *  policies that count observation calls (count-based speculation) and
   *  for driving the observation→context translator. The worklist has no
   *  analysis-identity branches in `observe`; whether an observation
   *  participates in speculation-context extension is a property the
   *  analysis declares here. */
  onObserve?(
    host: {
      handleObservationForSpec(
        source: Analysis<number, RawKind>,
        key: number,
        observed: RawKind,
      ): void;
    },
    key: K,
    value: V,
    context: Context,
  ): void;
  /** Compute the next stored value at `key` under `ctx.currentContext`.
   *  Reads happen via `ctx.read(someAnalysis, someKey)` (or the explicit
   *  `someAnalysis.store.read(key, ctx.currentContext)`). Return
   *  `undefined` for "no write"; the worklist writes the returned value
   *  into `this.store` at `ctx.currentContext` on its behalf. */
  transfer(ctx: AnalysisCtx, key: K): V | undefined;
}

/** Assumption-namespace token used in `Context` chains.
 *
 *  Structurally distinct from `Analysis<K, V>` — handles do NOT own a
 *  `store`, do NOT carry a `transfer` function, do NOT participate in
 *  worklist scheduling, and do NOT subscribe to fact-change edges. Their
 *  role is purely to identify *which* assumption a `(key, value)` pair
 *  binds when extending a Context, and to supply the value-equality
 *  relation used by `ContextInterner` to dedup `(handle, key, value)`
 *  triples so two call paths that converge on the same assumption set
 *  produce `===` context references.
 *
 *  Before the citizen split, `AssumptionHandle` was `Analysis<K, V>` —
 *  handles carried empty `edges`, a dummy `transfer`, `tier`, `polarity`,
 *  and a `storeAlgebra` only `.eq` was ever read from. The split removes
 *  those dead fields and makes the "handles don't store" fact a
 *  type-level guarantee rather than a runtime convention. */
export interface AssumptionHandle<K = unknown, V = unknown> {
  readonly id: symbol;
  readonly debugName: string;
  /** Documentation aid: names the key space (`"nodeId"`, `"FunctionId"`,
   *  etc.). Not consumed by the framework. */
  readonly keySpace?: string;
  /** Value-equality relation used by `ContextInterner.internChild` to
   *  dedup bucket entries at `(parent, handle, key)`. Also the default
   *  lineage-eq relation used by `Worklist.lineageOf` when the narrowing
   *  does not override `lineageEq`. Declared as a method so TypeScript
   *  treats it bivariantly — `AssumptionHandle<K, TypeLattice>` stays
   *  assignable to `AssumptionHandle<K, unknown>` for polymorphic
   *  Narrowing-list storage (matching the pre-split behavior when handles
   *  extended `Analysis` through its method-declared transfer). */
  eq(a: V, b: V): boolean;
}

/** A single dimension along which runtime observations can extend a
 *  speculation context. Bundles the identity (`handle`) named in Context
 *  assumption chains, the block DFA whose per-expression cells store the
 *  narrowed value, and the lift from raw observation to that value domain.
 *  Value equality is derived from the handle's `eq` at use sites —
 *  narrowings do not carry their own equality.
 *
 *  The worklist iterates a registered list of `Narrowing`s in four
 *  data-driven sites: observation→context translation, `widenGuard` and
 *  `widenUnitSpeculation`'s re-seed loops, and `lineageOf`'s synthetic
 *  Kildall runs. Adding a new narrowing dimension is a one-line
 *  registration; the framework does not name individual analyses.
 *
 *  `blockAnalysis` is a thunk so the narrowing can be constructed in
 *  `dfa-analyses.ts` in the same source position as the block analysis
 *  without hitting temporal-dead-zone issues on the self-reference.
 *
 *  `observationSource` ties this narrowing to a specific observation
 *  analysis — the runtime analysis whose writes feed this narrowing's
 *  extension pipeline. Narrowings over per-expression writes set
 *  `runtimeWriteAnalysis`; narrowings over per-function return kinds set
 *  `runtimeReturnAnalysis`. Observation→context translation filters
 *  narrowings by identity of the incoming observation's source so two
 *  narrowings keyed in different spaces (nodeId vs functionId) do not trigger
 *  each other's extension.
 *
 *  `resolveUnit` answers "whose speculation context does an observation at
 *  this key mutate?" Defaults to `ctx.topology.unitOfNode(key)` — correct
 *  for node-keyed observations. Return-kind-style narrowings whose key is
 *  an functionId override with `ctx.topology.unitOfFunctionId` so the extension lands
 *  on the called function's unit rather than the enclosing caller's.
 *
 *  `lineageValue` names the fact surface `Worklist.lineageOf` should diff
 *  when deciding whether an assumption is load-bearing for a guard. The
 *  default is the node-keyed expr fact at `(topology.blockOfNode(key), key)`,
 *  which is correct for write-driven per-expression narrowings. Narrowings
 *  keyed in a different space (e.g. return-kind keyed by functionId) override it
 *  to point at the relevant block fact under that key-space. `lineageEq`
 *  supplies the equality relation for that chosen surface; the default
 *  reuses the handle's `eq`. */

export interface Narrowing<K = any, V = unknown> {
  readonly handle: AssumptionHandle<K, V>;
  readonly blockAnalysis: () => BlockFixpointAnalysis<any>;
  readonly observationSource: Analysis<K, RawKind>;
  resolveUnit?(ctx: AnalysisCtx, key: K): Unit | undefined;
  lineageValue?(unit: Unit, key: K, context: Context): unknown;
  lineageEq?(a: unknown, b: unknown): boolean;
  lift(observed: RawKind): V | undefined;
}

/** Context handed to every `transfer` and wake dispatch.
 *
 *  `topology` is the readonly projection of the program's node/block/unit/fd
 *  indices — the single surface for node→block, node→unit, functionId→unit
 *  lookups.
 *
 *  `currentContext` is the speculation context under which the current call
 *  is running. Use `findAssumption(ctx.currentContext, handle, key)` to
 *  fetch narrowing assumptions bound in this chain. ROOT_CONTEXT when no
 *  speculation is active.
 *
 *  `read` / `tryRead` / `readAll` delegate to `analysis.store.*` at
 *  `currentContext` — the typical transfer-read pattern. For cross-context
 *  reads (unusual), call `analysis.store.read(key, otherContext)` directly. */
export interface AnalysisCtx {
  readonly topology: ProgramTopology;
  readonly currentContext: Context;
  read<K, V>(analysis: Analysis<K, V>, key: K): V;
  tryRead<K, V>(analysis: Analysis<K, V>, key: K): V | undefined;
  readAll<K, V>(analysis: Analysis<K, V>): ReadonlyMap<K, V>;
  /** Write at `currentContext` AND publish a `FactChange` through the
   *  worklist's dispatch list. Use this for paired-cell side-effect writes
   *  (e.g. the DFA factory writing `.facts` from inside `.env`'s transfer):
   *  calling `analysis.store.write` directly would skip listener fan-out,
   *  leaving subscribers unwoken. Transfer return values flow through the
   *  same dispatch automatically — `ctx.write` is for cases that can't
   *  express themselves through return. Returns `true` iff the cell
   *  advanced. */
  write<K, V>(analysis: Analysis<K, V>, key: K, value: V): boolean;
  /** Evict at `currentContext`. Effects use this for self-cleanup. */
  evict<K, V>(analysis: Analysis<K, V>, key: K): void;
}

/** Root-only fact surface exposed to transforms. Unconditional AST rewrites
 *  must not consult speculative/non-ROOT cells, so the transform contract is
 *  intentionally narrower than `AnalysisCtx` — no `write`, no per-context
 *  reads. Every read delegates to `analysis.store.*` at ROOT_CONTEXT.
 *
 *  Also carries `topology` so transforms that need node→block resolution
 *  (e.g. `readExprFact`, per-node fact lookups inside an expression visitor)
 *  go through the same surface every other consumer uses. */
export interface TransformFactView {
  read<K, V>(analysis: Analysis<K, V>, key: K): V;
  tryRead<K, V>(analysis: Analysis<K, V>, key: K): V | undefined;
  readAll<K, V>(analysis: Analysis<K, V>): ReadonlyMap<K, V>;
  readonly topology: ProgramTopology;
}

/** One-shot or cascading imperative AST sweep gated on analyses. Transforms
 *  are not `Analysis<_, _>` — they have no lattice, no transfer, and do not
 *  participate in the fact-store fixpoint. Worklist dirties a rule on unit
 *  mint / rebuild and on writes to any analysis declared in `edges`; the rule's
 *  `sweep` runs once per dirty unit after `processQueue` drains, and units
 *  that rewrote are scheduled for CFG rebuild. Idempotency across rebuilds
 *  is the rule's responsibility: dead-branch / const-folding are naturally
 *  idempotent (rewriting removes the precondition); memoization must track
 *  its own wrapped-set. */
export interface TransformRule {
  readonly id: symbol;
  readonly debugName: string;
  /** Fact-driven wake edges — reuses `FactEdge<Unit>` so transform
   *  and analysis edges go through the same dispatch shape. A write to the
   *  edge's `analysis` calls `wake(ctx, key)`, which yields the units to add to
   *  this rule's dirty set. Omit for a rule that only fires on mint/rebuild. */
  readonly edges?: ReadonlyArray<FactEdge<Unit>>;
  /** Lifecycle events that auto-dirty every unit. Defaults to both `"mint"`
   *  and `"rebuild"` — the historical behavior. Rules that drive dirtying
   *  purely from fact edges can opt out with `[]`. Explicit so the
   *  mint/rebuild auto-dirty is visible in the type rather than hidden
   *  inside `Worklist.registerTransform`. */
  readonly autoDirtyOn?: ReadonlyArray<"mint" | "rebuild">;
  /** Returns `true` iff `unit.body` was mutated — the worklist then schedules
   *  a CFG rebuild for `unit`. The fact surface is root-only by type, so a
   *  transform cannot accidentally read speculative context cells. */
  sweep(unit: Unit, facts: TransformFactView): boolean;
}

/** Construct an Analysis, auto-attaching its `store` from `storeAlgebra`
 *  and `emptyValue`. The store is what carries the analysis's cells;
 *  declaring it inline in every literal would be boilerplate that drifts
 *  from the algebra. Callers that want to mint an analysis pass a `spec`
 *  equivalent to the old literal form minus the `store` field.
 *
 *  Every plain-Analysis declaration site (runtimeWriteAnalysis,
 *  purityScopeAnalysis, the block-DFA factory's env/facts pair, …) goes
 *  through this helper so storage ownership is uniform. */
export function defineAnalysis<K, V>(
  spec: Omit<Analysis<K, V>, "store">,
): Analysis<K, V> {
  return {
    ...spec,
    store: new AnalysisStore<K, V>(spec.storeAlgebra, spec.emptyValue),
  };
}
