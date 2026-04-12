## What exists now

Branch `worktree-pr3-hint-store` has the reactive optimization architecture
implemented. All 2587 tests pass (2563 existing + 24 new differential tests).

### Architecture overview

```
createReactiveOptimization(ast, envs) → ReactiveOptimization
  .units           → ReadonlyMap<ScopeKey, VersionedFunctionUnit>
  .subscribe(cb)   → notified when any unit changes
  .converge()      → run to fixpoint (initial static pass)
  .tick(limit?)    → incremental processing
  .enqueue(item)   → inject runtime observations
  .idle            → true when no work remains
```

Two paths coexist:
- **One-shot:** `optimize()` → `OptimizationSession.converge()` → done. Used by `PySvmlEvaluator`. Unchanged.
- **Reactive:** `createReactiveOptimization()` → `PersistentWorklist` with unified priority scheduling. Used by `PySvmlJitEvaluator` (skeleton). New.

### Files created

**`src/specialization/framework/persistent-worklist.ts`** (~200 lines)
- `PersistentWorklist`: unified scheduler with multi-queue priority.
- Priority order: type analysis blocks → const analysis blocks → transforms.
  Transforms only fire at local fixpoint (all analysis drained first).
- Generation counters on per-scope state prevent stale block items from
  processing after a CFG rebuild.
- `addScope()`, `enqueue()`, `drain(limit?)`, `idle`, `pending`.
- Work item types: `AnalysisBlockItem`, `TransformScopeItem`, `ObservationItem`.

**`src/specialization/reactive.ts`** (~100 lines)
- `createReactiveOptimization()` factory.
- `ReactiveOptimization` interface with subscribe/converge/tick/enqueue.
- Wraps `PersistentWorklist` + `buildVersionedFunctionUnits()`.

**`src/specialization/framework/scope-index-map.ts`** (~30 lines)
- `ScopeIndexMap`: bidirectional `ScopeKey ↔ functionIndex` mapping.
- Populated during SVML compilation via `compiler.scopeIndexMap`.
- Consumed by `SVMLProgram.withSpecializedFunction(index, newIR)`.

**`src/conductor/PySvmlJitEvaluator.ts`** (~50 lines)
- Skeleton JIT evaluator. Currently functionally identical to `PySvmlEvaluator`
  but uses `createReactiveOptimization()` + `converge()`.
- Subscription-based recompilation is stubbed (blocked on Gap 2).

**`src/tests/reactive-optimization.test.ts`** (24 tests)
- Differential correctness: reactive `converge()` vs one-shot `optimize()`.
- Dual versioning: `structuralVersion` and `hintVersionSnapshot` behavior.
- Subscription notifications, tick semantics, multi-scope independence.

### Files modified

**`src/specialization/framework/worklist.ts`**
- Exported 6 previously-private functions for `PersistentWorklist` reuse:
  `computeBlockIN`, `transferBlock`, `mergeInto`, `outgoingBlocks`,
  `seedBlock`, `sentinelBlock`.
- `drainWorklist` remains private. `drainAllAnalyses` still exported.

**`src/specialization/framework/function-unit.ts`**
- New: `ScopeKey` type alias (`FileInput | FunctionDef`).
- New: `VersionedFunctionUnit` interface extending `FunctionUnit` with
  `structuralVersion` (bumps on transforms) and `hintVersionSnapshot`
  (tracks `hints.version` at last convergence).
- New: `buildVersionedFunctionUnits()` wrapping `buildFunctionUnits()`.

**`src/specialization/framework/hint.ts`** (from prior work, unchanged this session)
- `HintStore` with version tracking + `changesSince(version)`.

**`src/specialization/framework/session.ts`** (from prior work, unchanged this session)
- `OptimizationSession` with step/applyTransforms/converge. Remains as the
  convenience wrapper for the non-JIT path.

**`src/specialization/optimize.ts`**
- Re-exports `createReactiveOptimization` and reactive types.

**`src/specialization/index.ts`**
- Barrel exports for all new types: `PersistentWorklist`, `ScopeIndexMap`,
  `ReactiveOptimization`, `ScopeKey`, `VersionedFunctionUnit`, etc.

**`src/engines/svml/svml-compiler.ts`**
- `fromProgramUnit()` parameter widened from `Map` to `ReadonlyMap`.
- `ScopeIndexMap` populated during compilation: root scope registered in
  `fromProgramUnit()`, child scopes in `fromFunctionNode()`.
- New getter: `compiler.scopeIndexMap`.

**`src/conductor/index.ts`**
- Exports `PySvmlJitEvaluator`.

### Design decisions made (do not revisit)

1. **Unified worklist with two-tier priority** — analysis blocks and transforms
   share one scheduler. Transforms fire only when all analysis queues are empty.
   Not the simpler "two-phase wrapped" option. Chosen deliberately.

2. **Multi-queue priority** — one queue per analysis module + one for transforms.
   Type analysis drains before const analysis (preserves dependency order).
   No priority heap — just drain queues in index order.

3. **Generation counters** — stale worklist items (from pre-rebuild CFGs) are
   skipped rather than eagerly purged. Bounded overhead, simpler code.

4. **No block-level dedup in PersistentWorklist** — same block may appear
   multiple times (once per changed predecessor). Convergence check
   (`outEnv.equals(prevOut)`) short-circuits redundant processing. Same
   correctness guarantee as the original `drainWorklist`, just without the
   `inQueue` set optimization.

5. **Dual versioning** — `structuralVersion` (transforms) and `hintVersionSnapshot`
   (annotations) are separate concerns. Subscribers can distinguish "hints
   refined" (safe, monotonic) from "AST restructured" (needs consumer readiness).

6. **`OptimizationSession` retained** — not superseded. Remains the right
   abstraction for one-shot optimization and for tests that want step-level
   control within a single scope.

7. **`ScopeIndexMap` populated at compile time** — the compiler already walks
   scopes in DFS order to assign indices. Recording the mapping is ~5 lines.

8. All decisions from the prior session (no SessionConfig, no Intent concept,
   drainWorklist stays as-is, runCFGOptimization kept deprecated) still hold.

---

## What needs to happen next

### Priority 1: Gap 2 — Interpreter program swap

`SVMLInterpreter.program` is `private` and set at construction. The JIT
evaluator needs to swap the program between execution cycles (not
mid-execution, per Decision 3).

**What to do:**
- Add `replaceProgram(newProgram: SVMLProgram): void` to `SVMLInterpreter`.
  Asserts the interpreter is not mid-execution. Sets `this.program`.
- Wire the JIT evaluator's subscription callback:
  ```
  reactive.subscribe(changed => {
    for (const key of changed) {
      const idx = scopeMap.getIndex(key);
      if (idx !== undefined) {
        // recompile the changed function unit
        program = program.withSpecializedFunction(idx, recompile(unit));
      }
    }
    interpreter.replaceProgram(program);
  });
  ```
- This closes the reactive loop: analysis refines → subscriber recompiles →
  interpreter picks up new code.

**Why first:** It's ~20 lines and makes the JIT evaluator testable end-to-end.
Everything else in the reactive architecture is live but unobservable without
this.

**Open question:** What does "recompile a single function" mean concretely?
`SVMLCompiler` compiles the whole program in one pass. Recompiling a single
`FunctionDef` requires either (a) a partial-compile API on `SVMLCompiler`, or
(b) recompiling the whole program and extracting the changed function's IR.
Option (b) is wasteful but correct and unblocks testing. Option (a) is the
eventual target.

### Priority 2: Experiment 1 — Measure convergence cost

**Question:** How many worklist iterations does a typical program take? Is
batch re-analysis fast enough that incremental infrastructure is unnecessary
for programs under 1000 LOC?

**What to do:**
- Instrument `PersistentWorklist.drain()` to count total items processed.
- Run against the existing test corpus + a few larger programs (stdlib tests,
  linked-list tests).
- Record: items processed, wall-clock time, number of transform rounds.
- If batch re-analysis takes <10ms for target program sizes, the subscription
  architecture pays for itself in pedagogical value (live visualization), not
  performance. This recalibrates urgency of Gap 4.

**Why second:** Calibrates whether Gap 4 (CFG mutation) is urgent or can
wait indefinitely.

### Priority 3: Gap 4 — CFG mutation API (if Experiment 1 warrants it)

`buildCFG` produces a fresh immutable CFG. Every transform round rebuilds
from scratch. For the persistent model, the CFG should be mutated in-place.

**What to do:**
- Add mutable methods to CFG: `addEdge`, `removeEdge`, `splitBlock`, `mergeBlock`.
- Transform rules return mutation descriptors instead of (or in addition to)
  directly splicing the AST.
- PersistentWorklist applies mutations to CFG rather than rebuilding.

**Why deferred:** Rebuild-from-scratch works and is correct. Only becomes a
bottleneck for large programs or high transform-round counts.

### Priority 4: Experiment 4 — Live annotation visualization

Wire the CSE machine to read `.hint` annotations and display type/const info
in the stepper UI. No subscription system needed — just eagerly read
annotations before each step.

**Why valuable:** Tests the pedagogical hypothesis ("students watch the
optimizer think") before building more reactive infrastructure for it.

**Prerequisite:** Understanding the CSE machine's execution model and how
it renders step state. Key files: `src/engines/cse/`, `src/conductor/PyCseEvaluator.ts`.

### Not next (explicitly deferred)

- **Memoization analysis (Decision 4):** Requires runtime call-count
  observations flowing through `enqueue()`. Blocked on Gap 2 + OBSERVE opcode.
- **OBSERVE opcode (Experiment 3):** Runtime type profiling buffer. Phase 5+
  of the JIT plan.
- **Gap 5 (buildFunctionUnits rebuild):** Only needed when memoization adds
  wrapper functions that create new scopes.
- **Inter-procedural analysis:** Unnecessary per roadmap. Lazy memoized
  function summaries keyed on `(FunctionDef, paramLattices[])` suffice.

---

## Codebase conventions

- Test files live in `src/tests/`, not colocated with source.
- Use `yarn test` (never npm). Test runner is Jest.
- `parse()` from `../parser/parser-adapter` + `analyzeWithEnvironments()` from
  `../resolver` is the standard test setup for getting ASTs with environments.
- Existing test helpers: see `dfa-fixpoint.test.ts` for `analyseTopLevel()`
  pattern, `transform-rules.test.ts` for `optimise()` pattern,
  `reactive-optimization.test.ts` for `createReactiveOptimization()` pattern.
- TypeLattice constructors like `positiveInteger()`, `join()`, `constOf()` are
  all exported from `../specialization` barrel.
- Differential testing pattern: parse the same code twice (independent ASTs),
  run both paths, compare serialized AST structure with `serializeStmts()`.
  See `reactive-optimization.test.ts` and `optimization-session.test.ts`.
