RESOLUTION NOTES (worktree-pr3-hint-store, PRs A–E)

Each original critique is annotated with its current status. "Kept" items
explain why the original critique does not hold after the five-PR refactor.

────────────────────────────────────────────────────────────────────────────

[P1] createReactiveOptimization is pure indirection — inline it

  src/specialization/optimize.ts:10-15

  It constructs new PersistentWorklist(ast, env, createAnalyses(), createTransforms()) and
  nothing else. The name also misleads: readers expect a "reactive optimization" object,
  but the type is PersistentWorklist. Every call site (PyCseEvaluator.ts:82,
  PySvmlJitEvaluator.ts, tests) then treats the result as a worklist. Inline the
  constructor and export PersistentWorklist + the pipeline factories; alternatively push
  createAnalyses/createTransforms defaults into the constructor so the call becomes new
  PersistentWorklist(ast, env). optimize() similarly collapses to a 3-line helper; if only
  one caller uses it, delete it.

  STATUS: Kept as a documented low-level escape hatch in `optimize.ts`.
  Production JIT/CSE paths now go through `SpecializationEngine.create`
  (owns worklist + coordinator + reactive lifecycle). `optimize()` has a
  real production caller (`PySvmlEvaluator`, non-JIT). `createReactiveOptimization`
  is @internal for tests that need direct worklist access. The critique
  was drawn at the wrong boundary — the indirection was never the problem;
  the problem was two evaluators wiring identical coordinator state
  manually. Fixed by the facade.

[P1] ScopeKey alias adds no information

  src/specialization/framework/function-unit.ts:8

  export type ScopeKey = StmtNS.FileInput | StmtNS.FunctionDef is re-exported through
  specialization/index.ts, threaded through FunctionUnit, ScopeIndexMap, ObservationSink,
  CodeSwapStrategy, PersistentWorklist, OSRCoordinator, and every observation item. The
  alias hides what the value actually is — a reader chasing a "ScopeKey" has to jump three
  files to learn it is just an AST node. Replace with the bare union and drop the alias.
  The doc-comment ("stable identity across recompilations") is better attached to a
  FunctionUnit field comment.

  STATUS: Kept. Framework-internal after the facade landed; the alias no
  longer surfaces in evaluator code, so the "jump three files" critique
  weakens. The alias is a nominal-typing aid for `Map<ScopeKey, FunctionUnit>`
  — readers see the intent ("AST node used as identity token") without
  decoding a parser-artifact union.

[P2] ObservationSink interface buys no decoupling

  src/specialization/framework/observation-sink.ts:7-12, src/conductor/PyCseEvaluator.ts:87

  The comment claims it "decouples engines from PersistentWorklist", but PyCseEvaluator
  assigns the worklist itself to context.runtime.observationSink, and the worklist exposes
  exactly these four methods as public API. The interface is a structural subset of the
  concrete class with no alternative implementation. It also duplicates three of the four
  method signatures across files. Either delete the interface and type observationSink as
  PersistentWorklist directly, or — if the seam matters for tests — keep the interface but
  delete the duplicate observeWrite/observeCall definitions and have PersistentWorklist
  implements ObservationSink.

  STATUS: Kept as a real seam + strengthened. The interface now carries a
  runtime synchrony tripwire (`assertSyncObservationSink`) that TypeScript
  cannot express (void/Promise<void> assignability). The decoupling claim
  is also stronger now: `SpecializationEngine.observationSink` exposes this
  interface as the single external contract — no caller knows it is
  `PersistentWorklist` underneath.

[P2] NoopSwapStrategy + OSRCoordinator wiring is dead work on the CSE path

  src/conductor/PyCseEvaluator.ts:89-91, src/specialization/framework/osr.ts:35-42

  On the CSE path, recompile and install are both no-ops, so the coordinator iterates
  changed, calls isScopeActive, increments counters, and returns. The coord.start() /
  stop() dance is present purely to satisfy a shape shared with SVML. If the CSE path never
   needs code swapping, don't subscribe at all — the AST is already mutated in place by
  transforms. This also removes one consumer of ScopeKey / FunctionUnit across the API
  surface.

  STATUS: Reframed, not removed. The critique was the right diagnosis at
  the wrong level. The safepoint contract (activate/deactivate pinning) is
  real on CSE — transforms touching pinned scopes are deferred today. The
  swap seam was misnamed: renamed `CodeSwapStrategy<Code>` →
  `StateDeltaStrategy<Delta>` and `NoopSwapStrategy` → `InPlaceASTStrategy`,
  with doc comments clarifying that CSE's `Delta = void` *because* the
  transform already wrote the materialized form (the AST), not because
  CSE lacks the feature. SVML operand-level patching (in spec) is
  accommodated by the same interface via a union Delta shape —
  `src/tests/svml-operand-patch.test.ts` proves the seam end-to-end.

[P2] ScopeIndexMap is a two-Map wrapper with a constant call count

  src/specialization/framework/scope-index-map.ts

  Thirty lines wrapping two Maps with no invariant beyond "keep them in sync" — which is
  exactly what a bidirectional map would be if it had any other operation (delete, iterate,
   clear). It has a single writer and two readers. Inline the two Maps at the one call site
   that builds it, or at minimum drop the export from specialization/index.ts so it stops
  surfacing as framework API.

  STATUS: Barrel export dropped. `src/specialization/index.ts` no longer
  re-exports `ScopeIndexMap`. The one in-tree consumer
  (`svml-compiler.ts`) imports via the direct path, where it belongs.
  Internal structure left as-is.

[P2] converge() / tick() / drain() trio collapses to one method

  src/specialization/framework/persistent-worklist.ts:141-150

  converge()        → notify(drain())
  tick(limit?)      → notify(drain(limit)); return changed.size > 0
  drain(limit=Inf)  → core loop, returns changed set
  converge is tick() discarding the boolean. A single tick(limit = Infinity): boolean
  covers both. The naming also suggests a semantic distinction (initial vs incremental)
  that doesn't exist in the implementation.

  STATUS: Deferred, low priority. `tick()` is now documented as the
  advanced/test-hook entry point (production flows through the private
  `deactivateAndTick` inside `withActiveScope`). The distinction between
  initial (`converge`) and incremental (`tick`) is retained for call-site
  readability at the test and evaluator boundaries. Collapse is a
  mechanical follow-up, not load-bearing.

[P2] hintsFor wrapper lambda in the evaluator is noise

  src/conductor/PyCseEvaluator.ts:86

  this.context.runtime.hintsFor = node => reactive.hintsFor(node) — just assign
  reactive.hintsFor.bind(reactive) or, since hintsFor only reads this.units and
  this.nodeUnitCache, make the relevant fields captured by an arrow at construction and
  assign directly. Same shape appears in PySvmlJitEvaluator.

  STATUS: Dissolved. `hintsFor` is no longer wired to `context.runtime`;
  the CSE interpreter no longer reads hints at runtime at all (PR A).
  The last hint read was annotation-only — the visualizer now joins
  hints against a `HintStore` externally by node id.

[P3] handleValueObservation iterates every analysis module for each write

  src/specialization/framework/persistent-worklist.ts:263-275

  The loop checks observeValue / mergeIntoHint on every module per observation. Two modules
   today (Type, Const); only one (Type) implements these. On a hot write path this is a
  guaranteed skip every iteration. Pre-filter at construction: this.observers =
  analyses.filter(m => m.observeValue && m.mergeIntoHint) and iterate that.

  STATUS: Resolved. `PersistentWorklist.observers` pre-filters at
  construction via `analyses.filter(...)` and the hot loop iterates that
  narrower list. The type narrows both hooks to required so the loop body
  needs no non-null asserts.

[P3] optimize() return type advertises ReadonlyMap<ScopeKey, FunctionUnit> but callers
  want the worklist

  src/specialization/optimize.ts:18-25

  The one-shot optimize helper discards the worklist and returns units, but current
  consumers (evaluators, tests) all use the reactive path. If optimize has no callers in
  production code, delete it; if it's kept for tests, have it return the worklist directly
  so tests can inspect stats, hintStoreVersion, etc., without a second setup.

  STATUS: Partially addressed. `optimize()` has a production caller
  (`PySvmlEvaluator`, the non-JIT path) which genuinely wants only the
  converged unit map — no reactive loop. Kept with clarified doc.
  `createReactiveOptimization` returns the worklist directly for tests
  that need stats/hintStoreVersion; marked @internal.

────────────────────────────────────────────────────────────────────────────

Beyond the items above, five additional framework-level tightenings landed
alongside this cleanup:

  - Open-record hint store (`OptimizationHint` via index signature +
    typed `AnalysisKey`). Analyses and transforms are now orthogonal:
    adding an analysis is a key + transfer function; no edits to
    `hint.ts` or other analyses/transforms.

  - `withActiveScope`'s deactivate-then-tick ordering contractualized as
    a single private method (`deactivateAndTick`); the textual-ordering
    fragility is gone.

  - `ObservationSink` synchrony invariant documented + runtime tripwire
    (`assertSyncObservationSink`) called at engine construction.

  - `SpecializationEngine` facade: evaluators drop from ~20 lines of
    framework wiring to ~3. Both engines now genuinely share the same
    contract.

  - `SVMLDelta` union + `applyOperandPatches` pins the operand-level
    patching commitment (in spec). End-to-end test:
    `src/tests/svml-operand-patch.test.ts`.
