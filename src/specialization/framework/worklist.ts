// Priority-scheduled worklist for analysis-graph dispatch.

import { PriorityQueue } from "@datastructures-js/priority-queue";
import { StmtNS } from "../../ast-types";
import type { FunctionEnvironments } from "../../resolver";
import {
  FunctionRegistry,
  buildFunctionRegistry,
  type FunctionScopeNode,
} from "./function-registry";
import {
  storeClearContext,
  storeEvict,
  storeReadAt,
  storeReadMinimal,
  storeWrite,
  type FactChange,
} from "./analysis-store";
import {
  buildUnits,
  buildOneUnit,
  wireCFG,
  type Unit,
} from "./function-unit";
import {
  REGISTERED_ANALYSES,
  type Analysis,
  type AnalysisCtx,
  type Narrowing,
  type TransformRule,
  type LifecycleEdge,
  type Reading,
} from "./analysis";
import type { FunctionId, NodeId, ParamKey } from "./key-spaces";
import { ProgramTopology } from "./topology";
import { clearUnitBodies } from "./chain-body-store";
import { excludeAssumption, extendContext, findAssumption, hasAncestor, ROOT_CONTEXT, type Assumption, type AssumptionChain } from "./context";
import { immediateStrategy, type SpeculationStrategy } from "./speculation-strategy";
import { runtimeCallAnalysis, runtimeWriteAnalysis } from "./runtime-analyses";
import { purityBlockAnalysis, purityScopeAnalysis } from "../purity-analysis/analysis";
import { algebraicSimplifyRule } from "../transforms/algebraic-simplify";
import { constantFoldingRule } from "../transforms/constant-folding";
import { deadBranchRule } from "../transforms/dead-branch";
import { deadStoreRule } from "../transforms/dead-store";
import { memoizationRule } from "../transforms/memoization";
import { livenessAnalysis } from "../liveness-analysis/analysis";
import { definitelyBoundAnalysis } from "../definitely-bound-analysis/analysis";
import {
  typeAnalysis,
  constAnalysis,
  typeRequirementAnalysis,
  DEFAULT_NARROWINGS,
} from "./dfa-analyses";
import { runtimeReturnAnalysis } from "./runtime-analyses";
import { readExprFact } from "./dfa-factory";
import type { RawKind } from "./raw-value";
import {
  describeContext,
  formatKey,
  formatValue,
  type WorklistTracer,
} from "./tracer";

type QItem = { analysis: Analysis<any, any>; key: unknown; context: AssumptionChain; seq: number };

/** Reference to a speculative fact site. A backend emitting a guard for
 *  this fact publishes this ref via `Worklist.registerGuard` so the engine
 *  can trace back to the assumption(s) that drove the narrowing when the
 *  guard fires. `narrowing` + `key` together name the per-analysis store cell
 *  (the narrowing's block analysis, keyed by node id); no value is carried —
 *  the live value is read at deopt time from the owning analysis store.
 *
 *  Typed against `Narrowing<_, unknown>`: the lineage walk only calls
 *  `narrowing.blockAnalysis()` and reads the handle's store/value algebra for
 *  equality, neither of which needs the specific V. Keeping the interface
 *  ungenericized matches actual usage and removes a cosmetic type parameter. */
export interface SpecFactRef {
  readonly narrowing: Narrowing<NodeId | FunctionId | ParamKey, unknown>;
  readonly key: NodeId | FunctionId | ParamKey;
}

/** Narrow backend-facing interface for publishing guard provenance. Exposed
 *  as a separate type so backends can hold a capability-restricted reference
 *  (instead of the full `Worklist`) and so test doubles stay small. */
export interface GuardRegistrar {
  registerGuard(guardNodeId: number, ref: SpecFactRef): void;
}

/** Identity-key for an assumption. `narrowing` is compared by symbol
 *  identity (Narrowings are module singletons); `key` is compared by the
 *  JS `===` encoding used across the per-analysis stores. */
function assumptionKey(a: Assumption): string {
  return `${a.narrowing.debugName}:${String(a.key)}`;
}

/** Identity-key for a speculative fact ref — same encoding as
 *  `assumptionKey` so a pruned-assumption set can be checked against
 *  a guard's ref in O(1). */
function specRefKey(r: SpecFactRef): string {
  return `${r.narrowing.debugName}:${String(r.key)}`;
}

function unitDesc(unit: Unit): string {
  const ast = unit.funcAst;
  if (ast instanceof StmtNS.FunctionDef) {
    const nameNode = (ast as any).name;
    if (nameNode && typeof nameNode.name === "string") return `fn:${nameNode.name}`;
  }
  return `scope@${unit.slot}`;
}

function rawKindStr(raw: RawKind): string {
  if (raw.kind === "number" || raw.kind === "bool" || raw.kind === "string") {
    return `${raw.kind}(${String(raw.value)})`;
  }
  return raw.kind;
}

/** Default unit resolver for narrowings whose key is a nodeId. Shared
 *  identity so `buildUnitResolverBySource`'s agreement check compares
 *  function references rather than structural equivalents. */
const NODE_UNIT_RESOLVER = (ctx: AnalysisCtx, key: NodeId): Unit | undefined =>
  ctx.topology.unitOfNode(key);

/** Group narrowings by `observationSource` and assert each group agrees on
 *  `resolveUnit`. Disagreement used to silently resolve to the first
 *  narrowing's value — the later narrowing's context extension landed on
 *  the wrong unit with no error. Throws at construction so the registration
 *  bug surfaces before any observation fires. */
function buildUnitResolverBySource(
  narrowings: ReadonlyArray<Narrowing<any, any>>,
): Map<Analysis<any, RawKind>, (ctx: AnalysisCtx, key: any) => Unit | undefined> {
  const bySource = new Map<
    Analysis<any, RawKind>,
    (ctx: AnalysisCtx, key: any) => Unit | undefined
  >();
  for (const n of narrowings) {
    const resolver = n.resolveUnit ?? NODE_UNIT_RESOLVER;
    const existing = bySource.get(n.observationSource);
    if (existing === undefined) {
      bySource.set(n.observationSource, resolver);
      continue;
    }
    if (existing !== resolver) {
      throw new Error(
        `[Worklist] narrowings sharing observationSource=${n.observationSource.debugName} disagree on resolveUnit — all narrowings on one source must resolve to the same unit.`,
      );
    }
  }
  return bySource;
}

function buildNarrowingsBySource(
  narrowings: ReadonlyArray<Narrowing<any, any>>,
): ReadonlyMap<Analysis<any, RawKind>, ReadonlyArray<Narrowing<any, any>>> {
  const bySource = new Map<Analysis<any, RawKind>, Narrowing<any, any>[]>();
  for (const n of narrowings) {
    const group = bySource.get(n.observationSource);
    if (group === undefined) bySource.set(n.observationSource, [n]);
    else group.push(n);
  }
  return bySource;
}

const TIER_RANK = { runtime: 0, analysis: 1 } as const;

const compareItems = (a: QItem, b: QItem): number => {
  const ta = TIER_RANK[a.analysis.tier];
  const tb = TIER_RANK[b.analysis.tier];
  return ta - tb || a.seq - b.seq;
};

export class Worklist {
  /** Single source of truth for every cross-unit index — scope-node → unit,
   *  functionId → unit, nodeId → {unit, block}. Replaces the worklist's old
   *  `_units`, `unitsByFunctionId`, and `nodeToUnit` maps, and the per-unit
   *  `blockOfNode` field that used to live on `Unit`. */
  private readonly _topology = new ProgramTopology();

  /** Units awaiting CFG rebuild after a transform fire. */
  private readonly pendingRebuilds = new Set<Unit>();

  private readonly changeListeners: Array<(change: FactChange<unknown, unknown>) => void> = [];
  private readonly registeredAnalyses: Analysis<any, any>[] = [];
  private readonly queue = new PriorityQueue<QItem>(compareItems);
  private seqCounter = 0;
  /** Dedup guard: a given (analysis, context, key) enqueued twice before being
   *  drained is a single item. Context is part of the dedup identity because
   *  sibling contexts run independent Kildall. */
  private readonly pendingKeysByAnalysis = new Map<
    Analysis<any, any>,
    Map<AssumptionChain, Set<unknown>>
  >();

  /** Registered transforms and their dirty sets. A unit enters the dirty set
   *  on mint, rebuild, or a write to an upstream analysis declared in the rule's
   *  `edges`; sweep clears it. */
  private readonly transforms: TransformRule[] = [];
  private readonly transformDirty = new Map<TransformRule, Set<Unit>>();

  /** Per-unit active speculation context. Grows as `runtimeWriteAnalysis`
   *  observations land — each observation adds one assumption per
   *  registered narrowing whose `lift` accepts it (see `this.narrowings`).
   *  `widenWriteObservation` retracts per-observation; `widenFullChain`
   *  collapses the chain to ROOT when lineage can't be localized to a
   *  single link (see `widenGuard` for when that happens). Unset or
   *  ROOT_CONTEXT means the unit is currently emitting unspeculated IR.
   *  The tree structure is sibling-capable by construction; sibling
   *  materialization and subtree pruning follow in a later step. */
  private readonly currentSpecContext: Map<Unit, AssumptionChain> = new Map();

  /** Single fact-change dispatch index. Analyses and transforms both compile
   *  their fact edges into callbacks here; no per-subscriber-kind branching
   *  lives in `handleFactChange`. */
  private readonly factSubs = new Map<
    Analysis<any, any>,
    Array<(ctx: AnalysisCtx, key: unknown) => void>
  >();
  /** Single lifecycle dispatch index, one list per event kind. Analyses'
   *  `LifecycleEdge`s and transforms' mint/rebuild auto-dirtying both
   *  compile into callbacks here. */
  private readonly lifecycleSubs: Record<"mint" | "rebuild" | "retire" | "specContextChange",
    Array<(ctx: AnalysisCtx, unit: Unit) => void>
  > = { mint: [], rebuild: [], retire: [], specContextChange: [] };

  readonly registry: FunctionRegistry;
  private readonly functionEnvironments: FunctionEnvironments;

  /** Readonly projection of the topology — the surface consumers (DfaQuery,
   *  transforms outside the worklist, backends, tests) read through. */
  get topology(): ProgramTopology {
    return this._topology;
  }

  get units(): ReadonlyMap<FunctionId, Unit> {
    return this._topology.units;
  }

  /** Policy for when observations should extend the unit's speculation
   *  context. Defaults to `immediateStrategy` — every liftable observation
   *  triggers an extension. Swap in `countBasedStrategy(N)` (or a composed
   *  strategy) to suppress speculation on single outliers. */
  private readonly specStrategy: SpeculationStrategy;

  /** Registered speculation-narrowing dimensions. The observation translator,
   *  widen primitives, and `lineageOf` iterate this list — adding a new
   *  narrowing is a one-line registration here, not a framework edit. */
  private readonly narrowings: ReadonlyArray<Narrowing<any, any>>;

  /** Per-observation-source unit resolver, derived from `narrowings` at
   *  construction. All narrowings sharing an `observationSource` must
   *  agree on `resolveUnit` — the observation translator uses a single
   *  resolver per source; disagreement used to silently resolve via the
   *  first narrowing's value, leaving the later narrowing's context
   *  extension to land on the wrong unit with no error. */
  private readonly unitResolverBySource: Map<
    Analysis<any, RawKind>,
    (ctx: AnalysisCtx, key: any) => Unit | undefined
  >;

  /** Index of narrowings by `observationSource`, derived from `narrowings` at
   *  construction. Replaces O(m) filter on every observation with O(1) lookup. */
  private readonly narrowingsBySource: ReadonlyMap<
    Analysis<any, RawKind>,
    ReadonlyArray<Narrowing<any, any>>
  >;

  /** Optional trace sink. Zero cost when absent. Wired at construction. */
  private readonly tracer?: WorklistTracer;
  /** Incremented per trace event so the formatter can show global order. */
  private _traceSeq = 0;
  /** Set immediately before any enqueue call to record why the wake happened.
   *  Synchronous call sites (fact-edge dispatch, lifecycle edge, narrowing
   *  re-seed) stamp this field before invoking enqueue; the enqueue reads it. */
  private _enqueueReason = "";

  constructor(
    ast: StmtNS.FileInput,
    functionEnvironments: FunctionEnvironments,
    analyses: ReadonlyArray<Analysis<any, any>> = DEFAULT_PASSES,
    registry?: FunctionRegistry,
    transforms: ReadonlyArray<TransformRule> = DEFAULT_TRANSFORMS,
    specStrategy: SpeculationStrategy = immediateStrategy,
    narrowings: ReadonlyArray<Narrowing<any, any>> = DEFAULT_NARROWINGS,
    tracer?: WorklistTracer,
  ) {
    this.tracer = tracer;
    this.specStrategy = specStrategy;
    this.narrowings = narrowings;
    this.unitResolverBySource = buildUnitResolverBySource(narrowings);
    this.narrowingsBySource = buildNarrowingsBySource(narrowings);
    this.registry = registry ?? buildFunctionRegistry(ast);
    this.functionEnvironments = functionEnvironments;
    const built = buildUnits(ast, functionEnvironments, this.registry);
    for (const [, unit] of built) {
      if (!this.registry.hasNode(unit.funcAst)) {
        throw new Error(
          `[Worklist] unit for functionId=${unit.funcAst.id} missing from FunctionRegistry — registry likely built from a different AST`,
        );
      }
      this._topology.registerUnit(unit);
    }

    for (const p of analyses) this.register(p);
    for (const r of transforms) this.registerTransform(r);
    // The observation→context translator hooks directly into `observe`, not
    // via the change-listener list — an eq-gated write short-circuits
    // repeated same-value writes (the monotone fast path), and count-based
    // policies need to see every call, not every lattice change.

    // Initial units are seeded lazily: `register` replays onUnitMinted to each
    // analysis's subscriber, and `registerTransform` populates each rule's dirty
    // set with the existing units. Subsequent mints (mid-drain) fire
    // onUnitMinted via `onRegistryMint`.

    this.registry.setListener({
      onMint: (node, slot) => this.onRegistryMint(node, slot),
      onRetire: (functionId, node) => this.onRegistryRetire(functionId, node),
    });
  }

  private onRegistryMint(node: FunctionScopeNode, _slot: number): void {
    if (!(node instanceof StmtNS.FunctionDef)) return;
    const unit = buildOneUnit(node, this.functionEnvironments, this.registry);
    this._topology.registerUnit(unit);
    this.fireLifecycle("mint", unit);
  }

  private onRegistryRetire(functionId: FunctionId, _node: FunctionScopeNode): void {
    const unit = this._topology.unitOfFunctionId(functionId);
    if (unit === undefined) return;
    this.pendingRebuilds.delete(unit);
    this.currentSpecContext.delete(unit);
    this.guardProvenance.delete(unit);
    this.specStrategy.onUnitRetired?.(unit);
    for (const s of this.transformDirty.values()) s.delete(unit);
    clearUnitBodies(unit);
    // Each analysis declares its own eviction via `{on:"retire", effect}`.
    // Fire lifecycle BEFORE dropping topology indices so retire effects that
    // walk `topology.nodesOfUnit(unit)` still see the unit's nodes.
    this.fireLifecycle("retire", unit);
    this._topology.unregisterUnit(unit);
  }

  /** Return `rule`'s dirty set, asserting it exists. `registerTransform` is
   *  the only site that populates this map; call sites that touch it outside
   *  that function go through here so the invariant is named. */
  private dirtyFor(rule: TransformRule): Set<Unit> {
    const s = this.transformDirty.get(rule);
    if (s === undefined) {
      throw new Error(`[Worklist] transform "${rule.debugName}" has no dirty set — missed registerTransform?`);
    }
    return s;
  }

  private fireLifecycle(kind: "mint" | "rebuild" | "retire" | "specContextChange", unit: Unit): void {
    for (const sub of this.lifecycleSubs[kind]) sub(this.passCtx, unit);
  }


  /** Subscribe `fn` to writes against `upstream`. Called via `register` /
   *  `registerTransform`; not public API. */
  private subscribeFact(
    upstream: Analysis<any, any>,
    fn: (ctx: AnalysisCtx, key: unknown) => void,
  ): void {
    const list = this.factSubs.get(upstream) ?? [];
    list.push(fn);
    this.factSubs.set(upstream, list);
  }

  /** Register an analysis. Idempotent. Compiles each edge in `analysis.edges` into a
   *  callback on the unified dispatch indices (`factSubs` / `lifecycleSubs`).
   *  Lifecycle edges with `on: "mint"` fire immediately against every
   *  existing unit so late-registered analyses pick up the initial mint burst. */
  register<K, V>(analysis: Analysis<K, V>): void {
    if (this.registeredAnalyses.indexOf(analysis as Analysis<any, any>) !== -1) return;
    this.registeredAnalyses.push(analysis as Analysis<any, any>);
    REGISTERED_ANALYSES.add(analysis as Analysis<any, any>);
    const reader = analysis as Analysis<any, any>;
    const fireLifecycleEdge = (lc: LifecycleEdge<any>, unit: Unit): void => {
      if (lc.wake !== undefined) {
        this._enqueueReason = `lifecycle:${lc.on}:${unitDesc(unit)}`;
        for (const k of lc.wake(this.passCtx, unit)) this.enqueue(reader, k, ROOT_CONTEXT);
      }
      if (lc.effect !== undefined) lc.effect(this.passCtx, unit);
    };
    for (const spec of analysis.edges) {
      if (spec.on !== "fact") {
        this.lifecycleSubs[spec.on].push((_ctx, unit) => fireLifecycleEdge(spec, unit));
        continue;
      }
      const wake = spec.wake;
      const effect = spec.effect;
      const toRoot = spec.contextPolicy === "root";
      this.subscribeFact(spec.analysis, (ctx, key) => {
        if (effect !== undefined) effect(ctx, key);
        const enqueueCtx = toRoot ? ROOT_CONTEXT : ctx.currentContext;
        for (const k of wake(ctx, key)) this.enqueue(reader, k, enqueueCtx);
      });
    }
    // Replay existing-unit mints so registration order doesn't determine seeding.
    for (const spec of analysis.edges) {
      if (spec.on !== "mint") continue;
      for (const unit of this._topology.units.values()) fireLifecycleEdge(spec, unit);
    }
  }

  /** Register a transform rule. Idempotent. Existing units seed its dirty
   *  set; mint/rebuild auto-dirty the unit via lifecycle subscriptions; and
   *  each `edge` compiles into a fact subscription that dirties yielded
   *  units. All three paths funnel into the unified dispatch indices —
   *  transforms are not a special subscriber kind. */
  registerTransform(rule: TransformRule): void {
    if (this.transforms.indexOf(rule) !== -1) return;
    this.transforms.push(rule);
    const dirty = new Set<Unit>();
    for (const u of this._topology.units.values()) dirty.add(u);
    this.transformDirty.set(rule, dirty);

    const addUnit = (_ctx: AnalysisCtx, unit: Unit): void => { dirty.add(unit); };
    const auto = rule.autoDirtyOn ?? ["mint", "rebuild"];
    for (const kind of auto) this.lifecycleSubs[kind].push(addUnit);

    if (rule.edges !== undefined) {
      for (const edge of rule.edges) {
        const wake = edge.wake;
        this.subscribeFact(edge.analysis, (ctx, key) => {
          for (const u of wake(ctx, key)) dirty.add(u);
        });
      }
    }
  }

  /** Public read surface for tests and backends that hold a Worklist but
   *  not a specific Analysis reference's store. Thin delegation to
   *  `analysis.store.*`. `context` is mandatory on every helper: `Context`
   *  is the primitive, ROOT is one tree-root position inside it, and the
   *  worklist does not guess which position a caller meant. */
  read<K, V>(analysis: Analysis<K, V>, key: K, context: AssumptionChain): V {
    return analysis.store.read(key, context);
  }
  tryRead<K, V>(analysis: Analysis<K, V>, key: K, context: AssumptionChain): V | undefined {
    return analysis.store.tryRead(key, context);
  }
  readAll<K, V>(analysis: Analysis<K, V>, context: AssumptionChain): ReadonlyMap<K, V> {
    return analysis.store.readAll(context);
  }
  /** Exact positional read labeled with its witness. Uses the analysis
   *  store's default semantics for unwritten cells at `context`; callers
   *  that need to distinguish unwritten from bottom should use `tryRead`. */
  readAt<K, V>(analysis: Analysis<K, V>, key: K, context: AssumptionChain): Reading<V> {
    return storeReadAt(analysis.store, key, context);
  }
  /** Walk `context → ROOT`, returning the shallowest ancestor whose exact
   *  written cell satisfies `accept`. Unwritten ancestor cells are skipped. */
  readMinimal<K, V>(
    analysis: Analysis<K, V>,
    key: K,
    accept: (value: V) => boolean,
    context: AssumptionChain,
  ): Reading<V> | undefined {
    return storeReadMinimal(analysis.store, key, accept, context);
  }
  /** Writes through `analysis.store` AND publishes a `FactChange` to
   *  every subscriber — the single advancing-write site alongside
   *  `writeAndDispatch` (which is private, reused by `observe` and
   *  transfer-result handling). Returns `true` iff the cell advanced. */
  write<K, V>(
    analysis: Analysis<K, V>,
    key: K,
    value: V,
    context: AssumptionChain,
  ): boolean {
    return this.writeAndDispatch(analysis, key, value, context);
  }
  evict<K, V>(analysis: Analysis<K, V>, key: K, context: AssumptionChain): void {
    storeEvict(analysis.store, key, context);
  }

  /** Record a runtime observation made under `context`. The caller — typically
   *  the JIT observation adapter (`makeJitObservers`) — passes the speculation
   *  context the running body was dispatched under. Top-level observations
   *  with no enclosing specialized frame pass `ROOT_CONTEXT`.
   *
   *  Analyses that want to run observe-time logic (e.g. extend the unit's
   *  speculation context) declare `onObserve`. It fires BEFORE the
   *  monotone per-analysis-store write so count-based strategies see every
   *  call, including repeats the store would collapse. The worklist has no
   *  analysis-identity branches here — participation is a property each
   *  analysis declares on itself. */
  observe<K, V>(
    analysis: Analysis<K, V>,
    key: K,
    value: V,
    context: AssumptionChain,
  ): void {
    this.tracer?.onEvent({
      phase: "observe",
      seq: this._traceSeq++,
      analysis: analysis.debugName,
      key: formatKey(key),
      rawKind: formatValue(value),
    });
    analysis.onObserve?.(this.observationHost, key, value, context);
    this._enqueueReason = `observe:${analysis.debugName}(${formatKey(key)})`;
    this.writeAndDispatch(analysis, key, value, context);
    this.processQueue();
  }

  /** Capability surface handed to `Analysis.onObserve` hooks. Narrow
   *  wrapper around the worklist's private observation entry points;
   *  analyses don't receive the full `Worklist`. */
  private readonly observationHost = {
    handleObservationForSpec: (
      source: Analysis<any, RawKind>,
      key: any,
      observed: RawKind,
    ): void => {
      this.handleObservationForSpec(source, key, observed);
    },
  };

  hasPendingWork(): boolean {
    if (!this.queue.isEmpty() || this.pendingRebuilds.size > 0) return true;
    for (const s of this.transformDirty.values()) if (s.size > 0) return true;
    return false;
  }

  enqueue<K, V>(analysis: Analysis<K, V>, key: K, context: AssumptionChain): void {
    const p = analysis as Analysis<any, any>;
    let byContext = this.pendingKeysByAnalysis.get(p);
    if (byContext === undefined) {
      byContext = new Map();
      this.pendingKeysByAnalysis.set(p, byContext);
    }
    let pending = byContext.get(context);
    if (pending === undefined) {
      pending = new Set();
      byContext.set(context, pending);
    }
    if (pending.has(key)) return;
    pending.add(key);
    const seq = this.seqCounter++;
    this.tracer?.onEvent({
      phase: "enqueue",
      seq: this._traceSeq++,
      analysis: analysis.debugName,
      key: formatKey(key),
      context: describeContext(context),
      contextDepth: context.depth,
      reason: this._enqueueReason,
    });
    this.queue.enqueue({ analysis: p, key, context, seq });
  }

  /** Pop the PQ to empty. Tier order: runtime < analysis. Does not rebuild CFGs. */
  private processQueue(): void {
    while (!this.queue.isEmpty()) {
      const item = this.queue.dequeue()!;
      this.pendingKeysByAnalysis.get(item.analysis)?.get(item.context)?.delete(item.key);
      this.tracer?.onEvent({
        phase: "dequeue",
        seq: this._traceSeq++,
        analysis: item.analysis.debugName,
        key: formatKey(item.key),
        context: describeContext(item.context),
        contextDepth: item.context.depth,
      });
      const ctx = this.ctxFor(item.context);
      const value = item.analysis.transfer(ctx, item.key);
      this.tracer?.onEvent({
        phase: "transfer",
        seq: this._traceSeq++,
        analysis: item.analysis.debugName,
        key: formatKey(item.key),
        context: describeContext(item.context),
        contextDepth: item.context.depth,
        produced: value !== undefined,
      });
      if (value !== undefined) {
        this.writeAndDispatch(item.analysis, item.key, value, item.context);
      }
    }
  }

  /** Write via the framework-owned store helper and publish a `FactChange`
   *  to every listener registered on `factSubs`. This is the single site that
   *  funnels transfer results into the cell + fans them out to subscribers. */
  private writeAndDispatch<K, V>(
    analysis: Analysis<K, V>,
    key: K,
    value: V,
    context: AssumptionChain,
  ): boolean {
    const result = storeWrite(analysis.store, key, value, context);
    const advanced = result !== null;
    this.tracer?.onEvent({
      phase: "write",
      seq: this._traceSeq++,
      analysis: analysis.debugName,
      key: formatKey(key),
      context: describeContext(context),
      contextDepth: context.depth,
      advanced,
      oldValue: result !== null ? formatValue(result.prev) : formatValue(analysis.store.tryRead(key, context)),
      newValue: advanced ? formatValue(result!.next) : formatValue(value),
    });
    if (!advanced) return false;
    this.handleFactChange({
      analysis: analysis as Analysis<unknown, unknown>,
      key,
      context,
      oldValue: result!.prev,
      newValue: result!.next,
    });
    return true;
  }

  /** Sweep every registered transform over its dirty units. Units that
   *  rewrote move to `pendingRebuilds`. Returns true iff any rule fired. */
  private sweepTransforms(): boolean {
    let anyFired = false;
    for (const r of this.transforms) {
      const dirty = this.dirtyFor(r);
      if (dirty.size === 0) continue;
      const units = Array.from(dirty);
      dirty.clear();
      for (const unit of units) {
        // Rules sweep at the unit's active speculation chain. Reads go
        // through the chain directly; publication is `chain.forkBody(unit,
        // witness)` — under ROOT that resolves to `unit.funcAst.body`
        // without a copy.
        const chain = this.specAssumptionChainFor(unit);
        const fired = r.sweep(unit, chain, this._topology);
        this.tracer?.onEvent({
          phase: "transform-sweep",
          seq: this._traceSeq++,
          rule: r.debugName,
          unit: unitDesc(unit),
          fired,
        });
        if (fired) {
          this.pendingRebuilds.add(unit);
          anyFired = true;
        }
      }
    }
    return anyFired;
  }

  /** Allocate an `AnalysisCtx` bound to `context`. `read`/`tryRead`/`readAll`
   *  delegate to `analysis.store.*` at this context — the transfer-level
   *  read surface. `write`/`evict` go through the worklist's dispatch so
   *  side-effect writes fan out to subscribers (critical for the DFA
   *  factory's paired-cell `.facts` write from inside `.env`'s transfer).
   *  Cross-context reads still go through `analysis.store.read(key,
   *  otherContext)` directly when needed. */
  private makeCtx(context: AssumptionChain): AnalysisCtx {
    const topology = this._topology;
    const worklist = this;
    return {
      topology,
      currentContext: context,
      read<K, V>(analysis: Analysis<K, V>, key: K): V {
        return analysis.store.read(key, context);
      },
      tryRead<K, V>(analysis: Analysis<K, V>, key: K): V | undefined {
        return analysis.store.tryRead(key, context);
      },
      readAll<K, V>(analysis: Analysis<K, V>): ReadonlyMap<K, V> {
        return analysis.store.readAll(context);
      },
      write<K, V>(analysis: Analysis<K, V>, key: K, value: V): boolean {
        return worklist.writeAndDispatch(analysis, key, value, context);
      },
      evict<K, V>(analysis: Analysis<K, V>, key: K): void {
        storeEvict(analysis.store, key, context);
      },
    };
  }

  private readonly passCtx: AnalysisCtx = this.makeCtx(ROOT_CONTEXT);

  /** Build an `AnalysisCtx` scoped to `context`. The root context reuses
   *  `passCtx` (hot path); non-root contexts allocate a fresh one. */
  private ctxFor(context: AssumptionChain): AnalysisCtx {
    if (context === ROOT_CONTEXT) return this.passCtx;
    return this.makeCtx(context);
  }

  /** Publish a change event. Called by `writeAndDispatch` after the store
   *  reports an advancing write. Dispatches to every subscriber registered
   *  against `change.analysis` — analysis reader wake-ups and transform
   *  dirty-additions compiled into the same list — and also to any
   *  `onChange` listeners attached at the worklist level (used by poster /
   *  tracing harnesses).
   *
   *  The `ctx` passed to subscribers carries `change.context` as
   *  `currentContext`, so wake-ups enqueue under the same context the write
   *  originated in — cross-context ripple doesn't happen without an
   *  explicit context-crossing edge. */
  private handleFactChange(change: FactChange<unknown, unknown>): void {
    for (const l of this.changeListeners) l(change);
    const subs = this.factSubs.get(change.analysis as Analysis<any, any>);
    if (subs === undefined) return;
    const ctx = this.ctxFor(change.context);
    this._enqueueReason = `fact-change:${change.analysis.debugName}(${formatKey(change.key)})`;
    for (const sub of subs) sub(ctx, change.key);
  }

  /** Subscribe to every fact-advancing write published through this worklist.
   *  Narrower alternatives exist for specific patterns (analysis edges,
   *  transform edges); this list is for cross-cutting consumers like
   *  poster tracing. Returns a disposer that removes the listener. */
  onChange(listener: (change: FactChange<unknown, unknown>) => void): () => void {
    this.changeListeners.push(listener);
    return () => {
      const idx = this.changeListeners.indexOf(listener);
      if (idx !== -1) this.changeListeners.splice(idx, 1);
    };
  }

  /** Re-seed Kildall for every context-sensitive block analysis at `unit`'s
   *  entry block under `context`. Today that means every registered
   *  narrowing's block analysis plus `purityBlockAnalysis`: purity is not a
   *  narrowing dimension of its own, but witness discovery and memoization do
   *  need its per-context verdicts to exist at intermediate ancestor
   *  contexts. Used for exact-context probes (e.g. lineageOf) and as the
   *  primitive beneath full-path materialization. Callers set
   *  `_enqueueReason` before calling so the enqueue events carry the right
   *  causal label. */
  private enqueueNarrowingEntry(unit: Unit, context: AssumptionChain): void {
    for (const n of this.narrowings) {
      const bfa = n.blockAnalysis();
      // `.env` is the fixpoint driver; enqueuing the seed block on it
      // re-runs Kildall and produces paired `.facts` writes as a side effect.
      this.enqueue(bfa.env, bfa.seed(unit), context);
    }
    this.enqueue(purityBlockAnalysis.env, purityBlockAnalysis.seed(unit), context);
  }

  /** Translator: converts runtime observations from `source` into Context
   *  mutations on the owning unit, then re-seeds Kildall for each
   *  registered narrowing under the new context. An observation binds at
   *  most one assumption per narrowing — all bindings share the same
   *  Context chain so one compiled version depends on one chain (matches
   *  the artifact-tree model in the brief).
   *
   *  `source` identifies which observation analysis produced the event;
   *  only narrowings whose `observationSource === source` participate. A
   *  node-keyed observation from `runtimeWriteAnalysis` therefore drives
   *  only the node-keyed narrowings; an functionId-keyed observation from
   *  `runtimeReturnAnalysis` drives only the return-kind narrowing. `key`
   *  is in that narrowing's key-space — nodeId for writes, functionId for
   *  returns — and `n.resolveUnit` (default `topology.unitOfNode`) maps it to the
   *  owning unit.
   *
   *  Invoked directly from `observe` (not via store change dispatch) so
   *  count-based strategies see every observed call, including repeats the
   *  monotone store algebra would collapse.
   *
   *  Behavior:
   *  - No applicable narrowings for `source` → no-op.
   *  - Non-liftable raws → no-op.
   *  - `unknown` (⊤ widening) → prune any applicable-narrowing assumption
   *    at this key from the unit's current context. Bypasses the strategy
   *    — widening is a correctness retraction, not a policy choice.
   *  - Concrete lifts → strategy consulted; extensions gated on its verdict.
   *  - Concrete lifts matching existing assumptions → no-op (idempotent).
   *  - New / differing lifts → remove any conflicting assumption at this
   *    key, extend with the new bindings, update `currentSpecContext[unit]`,
   *    enqueue entry block on each applicable narrowing's analysis. */
  private handleObservationForSpec(
    source: Analysis<any, RawKind>,
    key: any,
    observed: RawKind,
  ): void {
    const applicable = this.narrowingsBySource.get(source);
    if (applicable === undefined || applicable.length === 0) return;

    // Per-source resolver is validated at construction — all narrowings on
    // this source agree on the resolver that ran here.
    const resolveUnit = this.unitResolverBySource.get(source) ?? NODE_UNIT_RESOLVER;
    const unit = resolveUnit(this.passCtx, key);
    if (unit === undefined) return;

    const parentCtx = this.currentSpecContext.get(unit) ?? ROOT_CONTEXT;

    if (observed.kind !== "unknown") {
      const accept = this.specStrategy.onObservation({
        unit,
        key,
        observed,
        parentContext: parentCtx,
      });
      this.tracer?.onEvent({
        phase: "strategy",
        seq: this._traceSeq++,
        unit: unitDesc(unit),
        key: formatKey(key),
        rawKind: rawKindStr(observed),
        accepted: accept,
        parentContextDepth: parentCtx.depth,
      });
      if (!accept) return;
    }

    if (observed.kind === "unknown") {
      let pruned = parentCtx;
      for (const n of applicable) {
        pruned = excludeAssumption(pruned, n, key);
      }
      if (pruned === parentCtx) return;
      if (pruned === ROOT_CONTEXT) this.currentSpecContext.delete(unit);
      else this.currentSpecContext.set(unit, pruned);
      this.tracer?.onEvent({
        phase: "context-exclude",
        seq: this._traceSeq++,
        unit: unitDesc(unit),
        handle: applicable.map(n => n.debugName).join("+"),
        key: formatKey(key),
        parentDepth: parentCtx.depth,
        resultDepth: pruned.depth,
        resultContext: describeContext(pruned),
      });
      this._enqueueReason = `observe-prune:${unitDesc(unit)}`;
      this.enqueueNarrowingEntry(unit, pruned);
      this.fireLifecycle("specContextChange", unit);
      this.tracer?.onEvent({
        phase: "spec-context-change",
        seq: this._traceSeq++,
        unit: unitDesc(unit),
        kind: "prune",
        newContextLabel: describeContext(pruned),
        newContextDepth: pruned.depth,
      });
      return;
    }

    let newCtx = parentCtx;
    for (const n of applicable) {
      const lifted = n.lift(observed);
      if (lifted === undefined) continue;
      const existing = findAssumption(newCtx, n, key);
      if (existing !== undefined && n.eq(existing, lifted)) continue;
      const cleaned = existing !== undefined
        ? excludeAssumption(newCtx, n, key)
        : newCtx;
      newCtx = extendContext(cleaned, n, key, lifted);
    }

    if (newCtx === parentCtx) return;
    this.tracer?.onEvent({
      phase: "context-extend",
      seq: this._traceSeq++,
      unit: unitDesc(unit),
      handle: applicable.map(n => n.debugName).join("+"),
      key: formatKey(key),
      value: rawKindStr(observed),
      parentDepth: parentCtx.depth,
      resultDepth: newCtx.depth,
      resultContext: describeContext(newCtx),
    });
    this.currentSpecContext.set(unit, newCtx);
    this._enqueueReason = `observe-extend:${unitDesc(unit)}`;
    this.enqueueNarrowingEntry(unit, newCtx);
    this.fireLifecycle("specContextChange", unit);
    this.tracer?.onEvent({
      phase: "spec-context-change",
      seq: this._traceSeq++,
      unit: unitDesc(unit),
      kind: "extend",
      newContextLabel: describeContext(newCtx),
      newContextDepth: newCtx.depth,
    });
  }

  /** Active speculation context for a unit. Readers of `typeAnalysis`
   *  looking for speculatively-narrowed facts should pass this context to
   *  `readExprFact` / `analysis.store.tryRead`. */
  specAssumptionChainFor(unit: Unit): AssumptionChain {
    return this.currentSpecContext.get(unit) ?? ROOT_CONTEXT;
  }

  /** Same as `specAssumptionChainFor`, keyed by nodeId. Convenience for consumers
   *  that only have an AST node id (e.g. the DfaQuery projection). */
  specAssumptionChainForNode(nodeId: NodeId): AssumptionChain {
    const unit = this._topology.unitOfNode(nodeId);
    return unit === undefined ? ROOT_CONTEXT : this.specAssumptionChainFor(unit);
  }

  /** Retract ALL speculation for `unit`. The sound-but-coarse widen used by
   *  `widenGuard` when `lineageOf` can't localize the violation to a single
   *  chain link. Two reasons that happens today:
   *
   *    1. Genuinely joint/redundant narrowing — no single assumption is
   *       load-bearing alone, so the minimum-sound prune is the whole chain.
   *    2. The narrowing did not provide a readable lineage surface under the
   *       current context, so the engine cannot localize the deopt to a
   *       smaller subset of assumptions.
   *
   *  Collapsing the chain to ROOT: Kildall re-runs under ROOT produce the
   *  non-narrowed facts, the `specContextChange` lifecycle fires, and jit-
   *  keyed analyses re-seed themselves on the next drain. Returns the unit
   *  that was widened, or `undefined` if the unit already has no active
   *  speculation. */
  private widenFullChain(unit: Unit): Unit | undefined {
    if (!this.currentSpecContext.has(unit)) return undefined;
    this.currentSpecContext.delete(unit);
    this.guardProvenance.get(unit)?.clear();
    this._enqueueReason = `widen-full:${unitDesc(unit)}`;
    this.enqueueNarrowingEntry(unit, ROOT_CONTEXT);
    this.fireLifecycle("specContextChange", unit);
    this.tracer?.onEvent({
      phase: "spec-context-change",
      seq: this._traceSeq++,
      unit: unitDesc(unit),
      kind: "prune-full",
      newContextLabel: "ROOT",
      newContextDepth: 0,
    });
    return unit;
  }

  /** Per-unit, per-guard-site record of which speculative fact the guard
   *  protects. Populated by backends via `registerGuard`; consumed by
   *  `widenGuard` on deopt to compute the load-bearing assumption set. Keyed
   *  by `guardNodeId` — the AST node id the backend baked into the guard
   *  opcode; that's the id `SpeculationViolation` carries. */
  private readonly guardProvenance: Map<Unit, Map<NodeId, SpecFactRef[]>> = new Map();

  /** Backend-facing hook, called once per emitted guard. Identifies the
   *  speculative fact whose narrowing the guard is protecting. No-op if
   *  `guardNodeId` doesn't resolve to a known unit. */
  registerGuard(guardNodeId: NodeId, ref: SpecFactRef): void {
    const unit = this._topology.unitOfNode(guardNodeId);
    if (unit === undefined) return;
    let perUnit = this.guardProvenance.get(unit);
    if (perUnit === undefined) {
      perUnit = new Map();
      this.guardProvenance.set(unit, perUnit);
    }
    const refs = perUnit.get(guardNodeId);
    if (refs === undefined) perUnit.set(guardNodeId, [ref]);
    else if (!refs.some(r => specRefKey(r) === specRefKey(ref))) refs.push(ref);
  }

  /** Lineage-precise deopt handle. Given a guard that fired at
   *  `guardNodeId`, prune just the assumption(s) in the owning unit's spec
   *  chain whose removal would widen the speculative fact at `ref`. Sibling
   *  assumptions (load-bearing for OTHER guards in the same unit) survive.
   *
   *  Missing provenance is a backend bug — every guard-emitting backend is
   *  required to call `registerGuard` at emission. Silently collapsing to
   *  ROOT used to paper over the omission; now we throw so the bug surfaces
   *  at its source instead of manifesting as a mysterious whole-unit widen.
   *
   *  Delegates to `widenFullChain` when the computed lineage is empty —
   *  that happens for genuinely joint/redundant narrowings (no single
   *  assumption is load-bearing alone) or when the narrowing offers no
   *  readable lineage surface for the current ref/context pair.
   *
   *  Returns the widened unit, or `undefined` if no unit owns `guardNodeId`. */
  widenGuard(guardNodeId: NodeId): Unit | undefined {
    const unit = this._topology.unitOfNode(guardNodeId);
    if (unit === undefined) return undefined;
    const refs = this.guardProvenance.get(unit)?.get(guardNodeId);
    if (refs === undefined || refs.length === 0) {
      throw new Error(
        `[widenGuard] no provenance for guard at node ${guardNodeId}. The backend that emitted this guard must call Worklist.registerGuard at emission — see svml-compiler.ts for the reference wiring.`,
      );
    }

    const ctx = this.currentSpecContext.get(unit);
    if (ctx === undefined || ctx === ROOT_CONTEXT) return undefined;

    const loadBearingMap = new Map<string, Assumption>();
    for (const ref of refs) {
      for (const a of this.lineageOf(ref, ctx, unit)) {
        loadBearingMap.set(assumptionKey(a), a);
      }
    }
    if (loadBearingMap.size === 0) return this.widenFullChain(unit);
    const loadBearing = [...loadBearingMap.values()];

    // `lineageOf` only pushes assumptions whose exclusion from `ctx` changes
    // the chain, so the first iteration below is guaranteed to advance
    // `pruned` off of `ctx`; the canonical interner has no cycle that could
    // bring it back. A `pruned === ctx` guard here would be unreachable.
    let pruned: AssumptionChain = ctx;
    for (const a of loadBearing) {
      pruned = excludeAssumption(pruned, a.narrowing, a.key);
    }

    this.tracer?.onEvent({
      phase: "widen-guard",
      seq: this._traceSeq++,
      guardNodeId,
      unit: unitDesc(unit),
      loadBearingAssumptions: loadBearing.map(assumptionKey),
      widenedToRoot: pruned === ROOT_CONTEXT,
    });

    if (pruned === ROOT_CONTEXT) this.currentSpecContext.delete(unit);
    else this.currentSpecContext.set(unit, pruned);
    // Drop provenance whose guard was protecting a pruned assumption. A
    // surviving guard may have listed a non-pruned assumption among its
    // load-bearing set; clearing *all* provenance for the unit would be
    // safe but throws away reusable entries. Trim precisely.
    const perUnit = this.guardProvenance.get(unit);
    if (perUnit !== undefined) {
      const prunedSet = new Set(loadBearing.map(a => assumptionKey(a)));
      for (const [gid, refsAtGuard] of perUnit) {
        const kept = refsAtGuard.filter(r => !prunedSet.has(specRefKey(r)));
        if (kept.length === 0) perUnit.delete(gid);
        else perUnit.set(gid, kept);
      }
    }
    this._enqueueReason = `widen-guard:${unitDesc(unit)}`;
    this.enqueueNarrowingEntry(unit, pruned);
    this.fireLifecycle("specContextChange", unit);
    return unit;
  }

  /** Identify assumptions in `ctx`'s chain whose removal widens the fact at
   *  `(ref.analysis, ref.key)`. Algorithm: for each link, synthesize the
   *  chain without it, re-seed Kildall for every registered narrowing
   *  under the synthesized chain (no transforms, no CFG rebuild), and diff
   *  the fact at `ref`. Cells under the synthetic chain are written to the
   *  owning analyses' stores and linger — contexts are identity-keyed so no
   *  collision, but an eviction pass is a later step (C5b follow-up).
   *
   *  Cost: O(Kildall-at-pruned-ctx). All pruned-context probes are enqueued
   *  in Phase 1; a single processQueue() drain in Phase 2 resolves them all
   *  simultaneously. Chain depth is bounded by the speculation strategy. */
  private lineageOf(
    ref: SpecFactRef,
    ctx: AssumptionChain,
    unit: Unit,
  ): Assumption[] {
    const { narrowing, key } = ref;
    const topology = this._topology;
    const lineageValue = narrowing.lineageValue
      ?? ((_owner: Unit, nodeId: NodeId, context: AssumptionChain) =>
        readExprFact(topology, narrowing.blockAnalysis(), nodeId, context));
    const current = lineageValue(unit, key as never, ctx);
    // No readable fact under `ctx` ⇒ narrowing has no lineage surface here;
    // `widenGuard` will fall back to `widenFullChain`. Distinct from the
    // per-iteration `widened === undefined` case below, which means "link
    // removal happened to land the pruned context on an unvisited cell."
    if (current === undefined) return [];
    const lineageEq = narrowing.lineageEq
      ?? ((a: unknown, b: unknown) => narrowing.eq(a as never, b as never));
    // Phase 1: collect all pruned contexts and enqueue them all before running
    // the fixpoint. Independent contexts don't share cells, so their Kildall
    // passes commute — one processQueue drain computes all of them at once
    // instead of O(chainDepth) sequential drains.
    const probes: Array<{ a: Assumption; without: AssumptionChain }> = [];
    for (let cur: AssumptionChain | undefined = ctx; cur !== undefined; cur = cur.parent) {
      const a = cur.assumption;
      if (a === undefined) continue;
      const without = excludeAssumption(ctx, a.narrowing, a.key);
      if (without === ctx) continue;
      probes.push({ a, without });
      this._enqueueReason = `lineage-probe:${unitDesc(unit)}`;
      this.enqueueNarrowingEntry(unit, without);
    }
    if (probes.length > 0) this.processQueue();

    // Phase 2: read results — all pruned contexts are now converged.
    const loadBearing: Assumption[] = [];
    for (const { a, without } of probes) {
      const widened = lineageValue(unit, key as never, without);
      // A link is load-bearing iff removing it widens the fact at `ref`.
      // Both reads can miss (returning undefined) if the pruned context has
      // no cell yet; treat `undefined === undefined` as unchanged, any
      // single-sided undefined as a change. Otherwise compare via the
      // block-fact lattice for the chosen lineage surface.
      const unchanged = current === widened
        || (current !== undefined && widened !== undefined
            && lineageEq(current, widened));
      if (!unchanged) loadBearing.push(a);
    }

    // Phase 3: evict synthetic probe-context cells from every registered
    // analysis's store. `widenGuard` computes the unit's new speculation
    // context by multi-excluding every load-bearing assumption; that context
    // gets re-enqueued and its cells must survive so the downstream Kildall
    // drain sees no-op joins (and fires no spurious change events to JIT
    // listeners). Every other probe is pure throwaway.
    if (probes.length > 0) {
      let finalPruned: AssumptionChain = ctx;
      for (const a of loadBearing) {
        finalPruned = excludeAssumption(finalPruned, a.narrowing, a.key);
      }
      for (const { without } of probes) {
        if (without === finalPruned) continue;
        for (const analysis of this.registeredAnalyses) {
          storeClearContext(analysis.store, without);
        }
      }
    }

    return loadBearing;
  }

  /** Rebuild CFG for every pending unit, then fire `onUnitRebuilt`. */
  private flushPendingRebuilds(): Unit[] {
    if (this.pendingRebuilds.size === 0) return [];
    const rebuilt: Unit[] = [];
    for (const unit of this.pendingRebuilds) {
      unit.generation++;
      wireCFG(unit);
      this._topology.reindexUnit(unit);
      // A CFG rebuild invalidates every guard's nodeId: the old ids belong
      // to AST subtrees that the backend hasn't seen yet. The next compile
      // will re-register guards with ids valid under the new generation.
      this.guardProvenance.delete(unit);
      rebuilt.push(unit);
    }
    this.pendingRebuilds.clear();
    for (const unit of rebuilt) this.fireLifecycle("rebuild", unit);
    return rebuilt;
  }

  /** Drain to fixed point. Each iteration:
   *   1. `processQueue` — analyses / observations converge.
   *   2. `sweepTransforms` — imperative AST rewrites on dirty units.
   *   3. `processQueue` — pick up any writes made by transforms (rare, but
   *      transforms may read analysis state that needs to be settled
   *      before rebuild for the next iteration's analyses).
   *   4. `flushPendingRebuilds` — rewire CFGs for units that fired; fires
   *      `onUnitRebuilt`, which re-enqueues analyses and re-marks transforms
   *      dirty.
   *  Terminates when no transform fired and no rebuild occurred.
   *
   *  This is the explicit heavy-weight publication barrier: it runs queued
   *  analyses to quiescence, sweeps transforms, and rebuilds any mutated CFGs.
   *  Online observation ingress happens in `observe()` via `processQueue()`;
   *  callers invoke `drain()` when they need transform/rebuild publication. */
  drain(limit: number = Worklist.DEFAULT_DRAIN_LIMIT): ReadonlySet<StmtNS.FileInput | StmtNS.FunctionDef> {
    const changed = new Set<StmtNS.FileInput | StmtNS.FunctionDef>();
    let processed = 0;
    let iteration = 0;

    while (true) {
      this.processQueue();
      const fired = this.sweepTransforms();
      this.processQueue();
      const rebuilt = this.flushPendingRebuilds();

      this.tracer?.onEvent({
        phase: "drain-iteration",
        seq: this._traceSeq++,
        iteration,
        transformsFired: fired,
        rebuiltUnits: rebuilt.map(unitDesc),
      });
      iteration++;

      if (!fired && rebuilt.length === 0) break;

      for (const unit of rebuilt) {
        changed.add(unit.funcAst);
        processed++;
      }

      if (processed >= limit) {
        throw new Error(
          `[Worklist] drain exceeded ${limit} CFG rebuilds — likely a non-terminating transform cascade. ` +
          `Raise the limit explicitly via drain(n) only if you've verified convergence.`,
        );
      }
    }

    return changed;
  }

  static readonly DEFAULT_DRAIN_LIMIT = 1000;
}

/** Default production analysis set. Tests may use a subset for isolation.
 *  Block DFAs contribute two analyses each — `.env` (the Kildall driver) and
 *  `.facts` (the per-node expr-facts cell populated as a paired side effect).
 *  Both must be registered: `.env` for its transfer + CFG self-wake, `.facts`
 *  for its rebuild/retire eviction edges. */
export const DEFAULT_PASSES: ReadonlyArray<Analysis<any, any>> = [
  runtimeWriteAnalysis,
  runtimeReturnAnalysis,
  runtimeCallAnalysis,
  typeAnalysis.env, typeAnalysis.facts,
  constAnalysis.env, constAnalysis.facts,
  typeRequirementAnalysis.env, typeRequirementAnalysis.facts,
  purityBlockAnalysis.env, purityBlockAnalysis.facts,
  purityScopeAnalysis,
  livenessAnalysis.env, livenessAnalysis.facts,
  definitelyBoundAnalysis.env, definitelyBoundAnalysis.facts,
];

export const DEFAULT_TRANSFORMS: ReadonlyArray<TransformRule> = [
  deadBranchRule,
  constantFoldingRule,
  algebraicSimplifyRule,
  deadStoreRule,
  memoizationRule,
];
