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
//   Narrowing<K, V>   — namespace token for `AssumptionChain` chains. Does NOT
//                       own a `store`. No transfer, no edges, no tier, no
//                       polarity, no `storeAlgebra`. Carries `id`,
//                       `debugName`, `keySpace?`, and `eq` — the
//                       value-equality relation the context interner uses
//                       to dedup `(narrowing, key, value)` triples — plus
//                       `blockAnalysis` / `observationSource` / `lift` that
//                       describe the dataflow dimension this narrowing
//                       inhabits. Narrowings cannot flow through the
//                       worklist's read/write surface; the type checker
//                       rejects it.
//
//                       `AssumptionHandle<K, V>` is retained as a minimal
//                       base shape (`id`, `debugName`, `keySpace?`, `eq`)
//                       that `Narrowing` extends. Production contexts are
//                       always bound against a full `Narrowing`; the base
//                       `AssumptionHandle` is used by synthetic test
//                       fixtures that need a context-identity token without
//                       pulling in a block DFA and observation source.
//
//   TransformRule     — imperative AST sweep (defined below). Registered via
//                       `worklist.registerTransform`; no lattice, no
//                       transfer, no store write. `sweep(unit, chain,
//                       topology)` returns `true` to trigger CFG rebuild;
//                       reads happen through the chain directly.

import type { StmtNS } from "../../ast-types";
import type { Unit } from "./function-unit";
import type { AssumptionChain } from "./context";
import type { RawKind } from "./raw-value";
import type { BlockFixpointAnalysis } from "./dfa-factory";
import type { ProgramTopology } from "./topology";
import { AnalysisStore, type ReadonlyAnalysisStore } from "./analysis-store";
// `Worklist` is referenced in the `bind?` method signature on `Analysis` and
// `TransformRule`. Imported as a type-only reference (`import type`) so this
// module stays in the leaf position of the framework dependency graph — there
// is no value-level dependency on `worklist.ts`, only the interface shape.
import type { Worklist } from "./worklist";

export type SemanticAnalysis<K, V> = Analysis<K, V> & { polarity: "may" | "must" };
export type OpaqueAnalysis<K, V> = Analysis<K, V> & { polarity: "opaque" };
export type SemanticBlockFixpointAnalysis<L> = BlockFixpointAnalysis<L> & {
  readonly env: SemanticAnalysis<any, any>;
  readonly facts: SemanticAnalysis<any, ReadonlyMap<number, L>>;
};

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
export interface JoinSemiLattice<V> {
  readonly bottom: V;
  leq(a: V, b: V): boolean;
  join(a: V, b: V): V;
  eq(a: V, b: V): boolean;
}

/** Bounded lattice: adds `top` and `meet` to `JoinSemiLattice<V>`. Required by DFA
 *  value-lattices — `meet` is the dual merge for "must" analyses, and `top`
 *  seeds MutableEnv slots when the generic block transfer widens (e.g. For
 *  loop targets). Cell-level base algebras over stored domains rarely need
 *  these; counters, sticky flags, and observation lattices often have no
 *  natural `top`/`meet`, so we keep the base interface permissive. */
export interface Lattice<V> extends JoinSemiLattice<V> {
  readonly top: V;
  meet(a: V, b: V): V;
}

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
   *  Writes/evicts go through framework-owned store helpers at
   *  `ctx.currentContext` or similar. Reads use `ctx.read(analysis, key)`
   *  etc. */
  effect?(ctx: AnalysisCtx, key: unknown): void;
}

export interface LifecycleEdge<K> {
  /** Event kinds:
   *   - `mint` / `rebuild` / `retire` — unit-lifecycle transitions.
   *   - `specContextChange` — the owning unit's active speculation context
   *     (`Worklist.specAssumptionChainFor`) has changed. Fires on observation-driven
   *     extend, on lineage-precise widen (`Worklist.widenGuard`), and on
   *     whole-unit widen (`Worklist.widenUnitSpeculation`). A pure context
   *     reset advances no facts, so fact-edge subscribers don't wake on their
   *     own — analyses whose output depends on `specAssumptionChainFor(unit)` (e.g.
   *     backend JIT recompile) subscribe here so deopt handlers don't have to
   *     enqueue them manually. */
  readonly on: "mint" | "rebuild" | "retire" | "specContextChange";
  wake?(ctx: AnalysisCtx, unit: Unit): Iterable<K>;
  effect?(ctx: AnalysisCtx, unit: Unit): void;
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
  /** Primary algebra over the stored cell domain `V`. Serves the analysis's
   *  stored cell domain — `AnalysisStore` consumes this for default value,
   *  storage combine, and equality/change detection. For plain analyses it
   *  is often the same object as the semantic lattice; for lifted analyses
   *  it is the outer/store algebra over the stored summary domain.
   *
   *  Consumed by the analysis's own `store` (at construction time) and by
   *  external callers that need the algebra surface (e.g. svml-jit-analysis'
   *  snapshot-matches comparison). */
  readonly storeAlgebra: JoinSemiLattice<V>;
  /** Optional explicit value for an unwritten cell. When absent, `store.read`
   *  falls back to `storeAlgebra.bottom`.
   *
   *  This separates absent-cell semantics from the broader algebra and makes
   *  lifted/synthetic store domains state their default directly instead of
   *  relying on readers to infer it from `polarity` or semantic meaning. */
  readonly emptyValue?: V;
  /** This analysis's cells. Publicly exposed as a read-only surface:
   *  callers can inspect `read` / `tryRead` / `readAll`, but cannot mutate
   *  or enumerate context partitions through the typed API. Framework-owned
   *  mutation/cleanup paths go through helpers in `analysis-store.ts` so
   *  listener fan-out remains centralized in the worklist.
   *
   *  Storage is owned by the Analysis itself; there is no shared external
   *  registry. Consumers reach cells via `analysis.store.read(key, context)`,
   *  or — for transforms — through the chain passed to `sweep`.
   *
   *  Construction is handled by `defineAnalysis({...})` so declarations
   *  stay literal-shaped without boilerplate. */
  readonly store: ReadonlyAnalysisStore<K, V>;
  readonly edges?: ReadonlyArray<EdgeSpec<K>>;
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
   *  BEFORE the store write. Fires once per observe call, including
   *  repeats the store algebra may collapse — appropriate for
   *  policies that count observation calls (count-based speculation) and
   *  for driving the observation→context translator. The worklist has no
   *  analysis-identity branches in `observe`; whether an observation
   *  participates in speculation-context extension is a property the
   *  analysis declares here. */
  onObserve?(
    host: {
      handleObservationForSpec<K>(
        source: Analysis<K, RawKind>,
        key: K,
        observed: RawKind,
      ): void;
    },
    key: K,
    value: V,
    context: AssumptionChain,
  ): void;
  /** Compute the next stored value at `key` under `ctx.currentContext`.
   *  Reads happen via `ctx.read(someAnalysis, someKey)` (or the explicit
   *  `someAnalysis.store.read(key, ctx.currentContext)`). Return
   *  `undefined` for "no write"; the worklist writes the returned value
   *  into `this.store` at `ctx.currentContext` on its behalf. */
  transfer(ctx: AnalysisCtx, key: K): V | undefined;
  /** Optional registration hook. Called by `Worklist.register` AFTER the
   *  analysis's legacy `edges` array has been lowered onto the dispatch
   *  index, so analyses may use `edges`, `bind`, or both during the PR-C/D
   *  migration window. Implementations subscribe via the typed `wl.on*`
   *  methods directly; the interface intentionally does not export an
   *  `Event` enum or `Subscription` wrapper at the author surface. */
  bind?(worklist: Worklist): void;
}

/** Minimal identity-token shape for `AssumptionChain` links.
 *
 *  Production code binds contexts against full `Narrowing<K, V>` objects
 *  (which extend this interface). `AssumptionHandle` is retained as the
 *  structural base so synthetic test fixtures can mint a context-identity
 *  token without constructing a block DFA and observation source they do
 *  not exercise. Every production `Narrowing` IS an `AssumptionHandle`.
 *
 *  Not an Analysis<K, V> — carries no `store`, no `transfer`, no edges, no
 *  tier, no polarity, no `storeAlgebra`. Exists only to identify *which*
 *  assumption a `(key, value)` pair binds when extending an AssumptionChain,
 *  and to supply the value-equality relation used by `ContextInterner` to
 *  dedup `(narrowing, key, value)` triples so two call paths that converge
 *  on the same assumption set produce `===` context references. */
export interface AssumptionHandle<K = unknown, V = unknown> {
  readonly id: symbol;
  readonly debugName: string;
  /** Documentation aid: names the key space (`"nodeId"`, `"FunctionId"`,
   *  etc.). Not consumed by the framework. */
  readonly keySpace?: string;
  /** Value-equality relation used by `ContextInterner.internChild` to
   *  dedup bucket entries at `(parent, narrowing, key)`. Also the default
   *  lineage-eq relation used by `Worklist.lineageOf` when the narrowing
   *  does not override `lineageEq`. Declared as a method so TypeScript
   *  treats it bivariantly — `AssumptionHandle<K, TypeLattice>` stays
   *  assignable to `AssumptionHandle<K, unknown>` for polymorphic
   *  Narrowing-list storage. */
  eq(a: V, b: V): boolean;
}

/** A single dimension along which runtime observations can extend a
 *  speculation context. Carries the identity fields named in AssumptionChain
 *  assumption chains (`id`, `debugName`, `keySpace?`, `eq` — inherited from
 *  `AssumptionHandle`), the block DFA whose per-expression cells store the
 *  narrowed value, and the lift from raw observation to that value domain.
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
 *  reuses the narrowing's `eq`. */

export interface Narrowing<K = any, V = unknown> extends AssumptionHandle<K, V> {
  readonly blockAnalysis: () => BlockFixpointAnalysis<any>;
  readonly observationSource: Analysis<K, RawKind>;
  resolveUnit?(ctx: AnalysisCtx, key: K): Unit | undefined;
  lineageValue?(unit: Unit, key: K, context: AssumptionChain): unknown;
  lineageEq?(a: unknown, b: unknown): boolean;
  lift(observed: RawKind): V | undefined;
}

/** Context handed to every `transfer` and wake dispatch.
 *
 *  `topology` is the read-only projection of the program's node/block/unit/fd
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
  readonly currentContext: AssumptionChain;
  read<K, V>(analysis: Analysis<K, V>, key: K): V;
  tryRead<K, V>(analysis: Analysis<K, V>, key: K): V | undefined;
  readAll<K, V>(analysis: Analysis<K, V>): ReadonlyMap<K, V>;
  /** Write at `currentContext` AND publish a `FactChange` through the
   *  worklist's dispatch list. Use this for paired-cell side-effect writes
   *  (e.g. the DFA factory writing `.facts` from inside `.env`'s transfer):
   *  bypassing the worklist's write path would skip listener fan-out,
   *  leaving subscribers unwoken. Transfer return values flow through the
   *  same dispatch automatically — `ctx.write` is for cases that can't
   *  express themselves through return. Returns `true` iff the cell
   *  advanced. */
  write<K, V>(analysis: Analysis<K, V>, key: K, value: V): boolean;
  /** Evict at `currentContext`. Effects use this for self-cleanup. */
  evict<K, V>(analysis: Analysis<K, V>, key: K): void;
}

/** Witness-labeled fact read. Produced by `chain.readMinimal` / `readAt` /
 *  `readExprFactMinimal` / `readExprFactAt`, and consumed by
 *  `chain.forkBody` as proof of authorization: a transform that has not
 *  read any fact has no `Reading<V>` to pass, and therefore cannot rewrite.
 *
 *  `witness` names the chain node that produced the value. For `readAt` /
 *  `readExprFactAt` that is the reading chain itself. For `readMinimal` /
 *  `readExprFactMinimal` that is the shallowest ancestor whose cell
 *  satisfied the caller's predicate — the most reusable assumption under
 *  which the rewrite is sound. */
export interface Reading<V> {
  readonly value: V;
  readonly witness: AssumptionChain;
}

/** One-shot or cascading imperative AST sweep gated on analyses. Transforms
 *  are not `Analysis<_, _>` — they have no lattice, no transfer, and do not
 *  participate in the analysis fixpoint. Worklist dirties a rule on unit
 *  mint / rebuild and on writes to any analysis declared in `edges`; the rule's
 *  `sweep` runs once per dirty unit after `processQueue` drains, and units
 *  that rewrote are scheduled for CFG rebuild. Idempotency across rebuilds
 *  is the rule's responsibility: dead-branch / const-folding are naturally
 *  idempotent (rewriting removes the precondition); memoization must track
 *  its own wrapped-set. */
export interface TransformRule {
  readonly debugName: string;
  /** Fact-driven wake edges — reuses `FactEdge<Unit>` so transform
   *  and analysis edges go through the same dispatch shape. A write to the
   *  edge's `analysis` calls `wake(ctx, key)`, which yields the units to add to
   *  this rule's dirty set. Omit for a rule that only fires on mint/rebuild. */
  readonly edges?: ReadonlyArray<FactEdge<Unit>>;
  /** Returns `true` iff the body at `chain` was mutated — the worklist
   *  then schedules a CFG rebuild for `unit`. The worklist always passes
   *  `chain = specAssumptionChainFor(unit)`; under ROOT that resolves to
   *  `unit.funcAst.body` via `chain.forkBody`, under a non-ROOT active
   *  context it returns the forked body there.
   *
   *  Profitability / opaque-analysis reads are no longer a typed surface:
   *  transforms reach for `ROOT_CONTEXT.read(counter, key)` explicitly.
   *  This keeps policy evidence visibly distinct from semantic proof at
   *  the call site rather than through a method name. */
  sweep(
    unit: Unit,
    chain: AssumptionChain,
    topology: ProgramTopology,
  ): boolean;
  /** Optional registration hook. Called by `Worklist.registerTransform` AFTER
   *  the rule's legacy `edges` have been lowered. Use the worklist's
   *  transform-typed `on*` methods (or the public `dirtyTransform(rule, unit)`
   *  shortcut) to add subscribers. */
  bind?(worklist: Worklist): void;
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
export function defineAnalysis<
  K,
  V,
  P extends Analysis<K, V>["polarity"],
>(
  spec: Omit<Analysis<K, V>, "store" | "polarity"> & { polarity: P },
): Analysis<K, V> & { polarity: P } {
  return {
    ...spec,
    store: new AnalysisStore<K, V>(spec.storeAlgebra, spec.emptyValue),
  };
}
