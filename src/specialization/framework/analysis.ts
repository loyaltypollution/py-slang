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
//   Narrowing<K, V>   — namespace token for `Speculation` chains. Does NOT
//                       own a `store`. No transfer, no edges, no tier, no
//                       polarity, no `storeAlgebra`. Identity is object
//                       reference (narrowings are module singletons).
//                       Carries `eq` — the value-equality relation the
//                       context interner uses to dedup `(narrowing, key,
//                       value)` triples — plus `blockAnalysis` /
//                       `observationSource` / `lift` that describe the
//                       dataflow dimension this narrowing inhabits.
//                       Narrowings cannot flow through the worklist's
//                       read/write surface; the type checker rejects it.
//
//   TransformRule     — imperative AST sweep (defined below). Registered via
//                       `worklist.registerTransform`; no lattice, no
//                       transfer, no store write. `sweep(unit, chain,
//                       topology)` returns `true` to trigger CFG rebuild;
//                       reads happen through analysis views, not the chain.

import { AnalysisStore, type ReadonlyAnalysisStore } from "./analysis-store";
import type { Speculation } from "./assumption-chain";
import type { BlockFixpointAnalysis } from "./dfa-factory";
import type { Unit } from "./function-unit";
import type { RawKind } from "./raw-value";
import type { ProgramTopology } from "./topology";
// `Worklist` is referenced in the `bind?` method signature on `Analysis` and
// `TransformRule`. Imported as a type-only reference (`import type`) so this
// module stays in the leaf position of the framework dependency graph — there
// is no value-level dependency on `worklist.ts`, only the interface shape.
import type { ObservationChannel } from "./observation-channel";
import type { Worklist } from "./worklist";
import type { BasicBlock } from "./cfg";
import type { FunctionId, NodeId } from "./key-spaces";

export type UnitResolver<K> = (ctx: AnalysisCtx, key: K) => Unit | undefined;

export const unitOfBlock: UnitResolver<BasicBlock> = (_ctx, block) => block.unit;
export const unitOfNodeId: UnitResolver<NodeId> = (ctx, nodeId) => ctx.topology.unitOfNode(nodeId);
export const unitOfFunctionId: UnitResolver<FunctionId> = (ctx, functionId) => ctx.topology.unitOfFunctionId(functionId);

export function wakeOwningUnit<K>(resolveUnit: UnitResolver<K>) {
  return (ctx: AnalysisCtx, key: K): Iterable<Unit> => {
    const unit = resolveUnit(ctx, key);
    return unit ? [unit] : [];
  };
}

export type SemanticAnalysis<K, V> = Analysis<K, V> & { polarity: "may" | "must" };
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
  /** Primary algebra over the stored cell domain `V`. Serves the analysis's
   *  stored cell domain — `AnalysisStore` consumes this for default value,
   *  storage combine, and equality/change detection. For plain analyses it
   *  is often the same object as the semantic lattice; for lifted analyses
   *  it is the outer/store algebra over the stored summary domain.
   *
   *  Consumed by the analysis's own `store` (at construction time) and by
   *  external callers that need the algebra surface for backend-local
   *  comparisons or publication policy. */
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
   *  registry. Canonical reads go through the Analysis object —
   *  `analysis.read(key, context)` / `analysis.tryRead(key, context)` /
   *  `analysis.readMinimal(chain, key, accept)` — so the key type stays
   *  tied to the specific analysis topology. The raw `store` remains a
   *  low-level read-only escape hatch for framework plumbing.
   *
   *  Construction is handled by `defineAnalysis({...})` so declarations
   *  stay literal-shaped without boilerplate. */
  readonly store: ReadonlyAnalysisStore<K, V>;
  /** Exact positional read at `context`. Uses the store's default value for
   *  unwritten cells. */
  read(key: K, context: Speculation): V;
  /** Exact positional read at `context`, returning `undefined` when the
   *  cell is unwritten. */
  tryRead(key: K, context: Speculation): V | undefined;
  /** Every written cell under `context`. Returns a read-only view of the
   *  backing partition. */
  readAll(context: Speculation): ReadonlyMap<K, V>;
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
   *
   *  This is an interpretation contract for reviewers and consumers, not a
   *  promise that `AnalysisStore` can derive absent-cell/default semantics
   *  from polarity alone. `BlockDfaSpec` carries `mergeKind`; polarity
   *  mirrors it for the wrapping Analysis. Non-fixpoint surfaces (runtime
   *  observations, profiler counts, backend publication) live on their
   *  own citizens — `ObservationChannel`, `CounterStore`, and
   *  `TransformRule` — not under a third polarity case. */
  readonly polarity: "may" | "must";
  /** Compute the next stored value at `key` under `ctx.currentContext`.
   *  Reads happen via `ctx.read(someAnalysis, someKey)` (or the explicit
   *  `someAnalysis.read(key, ctx.currentContext)`). Return `undefined` for
   *  "no write"; the worklist writes the returned value into `this.store`
   *  at `ctx.currentContext` on its behalf. */
  transfer(ctx: AnalysisCtx, key: K): V | undefined;

  /** Walk `chain → ROOT`, returning the shallowest ancestor whose written
   *  cell value satisfies `accept` as `{ value, witness }`. Unwritten
   *  ancestor cells are skipped. */
  readMinimal(
    chain: Speculation,
    key: K,
    accept: (value: V) => boolean,
  ): { value: V; witness: Speculation } | undefined;

  /** Walk `chain → ROOT`, returning the deepest ancestor with a written
   *  cell. Unwritten ancestor cells are skipped. */
  readDeepest(
    chain: Speculation,
    key: K,
  ): { value: V; witness: Speculation } | undefined;

  /** Optional registration hook. Called by `Worklist.register`.
   *  Implementations subscribe via the typed `wl.on*` methods directly; the
   *  interface intentionally does not export an event enum or edge wrapper at
   *  the author surface. */
  bind?(worklist: Worklist): void;
}

/** Sequentially compose an existing `bind` closure with an extension.
 *  Used when a caller wants to keep a factory-installed `bind` (lifecycle
 *  seeds, evicts, self-wake) AND add its own subscriptions — e.g. purity's
 *  cross-analysis scope→block wake on top of the DFA factory's bind.
 *
 *  Throws if `base` is undefined; an analysis that never had a bind has
 *  no factory subscriptions to preserve, and callers can assign `.bind`
 *  directly. Forcing the error at the call site catches the "decorate a
 *  never-bound analysis" bug instead of silently skipping half the setup. */
export function composeBind(
  base: ((wl: Worklist) => void) | undefined,
  extra: (wl: Worklist) => void,
): (wl: Worklist) => void {
  if (base === undefined) {
    throw new Error(
      "[composeBind] base bind is undefined — analysis has no prior bind to compose with.",
    );
  }
  return (wl) => {
    base(wl);
    extra(wl);
  };
}

export interface Narrowing<K = any, V = unknown> {
  eq(a: V, b: V): boolean;
  readonly blockAnalysis: () => BlockFixpointAnalysis<any>;
  readonly observationSource?: ObservationChannel<K, RawKind>;
  resolveUnit?: UnitResolver<K>;
  lift(observed: RawKind): V | undefined;
}

export interface AnalysisCtx {
  readonly topology: ProgramTopology;
  readonly currentContext: Speculation;
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

/** One-shot or cascading imperative AST sweep gated on analyses. Transforms
 *  are not `Analysis<_, _>` — they have no lattice, no transfer, and do not
 *  participate in the analysis fixpoint. Worklist dirties a rule on unit
 *  mint / rebuild and on writes to any analysis the rule subscribes to via
 *  `bind`; the rule's `sweep` runs once per dirty unit after `processQueue`
 *  drains, and units that rewrote are scheduled for CFG rebuild. Idempotency
 *  across rebuilds is the rule's responsibility: dead-branch /
 *  const-folding are naturally idempotent (rewriting removes the
 *  precondition); memoization must track its own wrapped-set. */
export interface TransformRule {
  /** Returns `true` iff the body at `chain` was mutated — the worklist
   *  then schedules a CFG rebuild for `unit`. The worklist always passes
   *  `chain = futureDispatchChainFor(unit)` (the unit's preferred chain for
   *  the next compile/sweep); under ROOT that resolves to
   *  `unit.funcAst.body` via `chain.forkBody`, under a non-ROOT active
   *  context it returns the forked body there.
   *
   *  Profitability / opaque-analysis reads are no longer a typed surface:
   *  transforms read counters directly (`counter.at(key)`). This keeps
   *  policy evidence visibly distinct from semantic proof at the call site
   *  rather than through a method name. */
  sweep(
    unit: Unit,
    chain: Speculation,
    topology: ProgramTopology,
  ): boolean;
  /** Optional registration hook. Called by `Worklist.registerTransform`.
   *  Use the worklist's transform-typed `on*` methods (or the public
   *  `dirtyTransform(rule, unit)` shortcut) to add subscribers. */
  bind?(worklist: Worklist): void;
}

/** Construct an Analysis, auto-attaching its `store` from `storeAlgebra`
 *  and `emptyValue`. The store is what carries the analysis's cells;
 *  declaring it inline in every literal would be boilerplate that drifts
 *  from the algebra. Callers that want to mint an analysis pass a `spec`
 *  equivalent to the old literal form minus the `store` field.
 *
 *  Every plain-Analysis declaration site (purityScopeAnalysis, the
 *  block-DFA factory's env/facts pair, …) goes through this helper so
 *  storage ownership is uniform. */
export function defineAnalysis<
  K,
  V,
  P extends Analysis<K, V>["polarity"],
>(
  spec: Omit<Analysis<K, V>, "store" | "polarity" | "read" | "tryRead" | "readAll" | "readMinimal" | "readDeepest"> & { polarity: P },
): Analysis<K, V> & { polarity: P } {
  const store = new AnalysisStore<K, V>(spec.storeAlgebra, spec.emptyValue);
  return {
    ...spec,
    store,
    read(key, context) {
      return store.read(key, context);
    },
    tryRead(key, context) {
      return store.tryRead(key, context);
    },
    readAll(context) {
      return store.readAll(context);
    },
    readMinimal(chain, key, accept) {
      return store.readMinimal(chain, key, accept);
    },
    readDeepest(chain, key) {
      return store.readDeepest(chain, key);
    }
  };
}
