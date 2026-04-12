# Specialization Cleanup — Execution Plan (Path 1)

**Audience**: an agent executing the cleanup.
**Companion**: `docs/specialization-audit.md` — read first, especially sections 2 (noun-to-pattern mapping) and 3 (bandaid map).
**Branch**: `worktree-pr3-hint-store` (working tree includes uncommitted changes; do not rebase away the working-tree state).
**Direction**: Path (a) — prune dead + miscategorized, accept the hand-stitching, document the pattern compensation. Path (b) — completing a literature pattern — is a **separate future initiative**. Do not start it here.

---

## 0. Prerequisites and invariants

### Package management
- **Yarn only.** Never `npm install`. Never generate `package-lock.json`.
- Run `yarn test` after each step. Do not commit if tests fail.

### Directory scope
- **Modify**: `src/specialization/`, `src/tests/` (for affected test files), `src/specialization/index.ts` (exports), the three evaluators (`src/conductor/PyCseEvaluator.ts`, `src/conductor/PySvmlEvaluator.ts`, `src/conductor/PySvmlJitEvaluator.ts`) for δ, `src/parser/resolver.ts` for the ε2 intrinsic rename, `scripts/dump-ast.ts` for δ.
- **Do not touch**: `docs/` *except* the single one-line note in Step 6 on `docs/optimization-roadmap.md` (explicitly scoped exception), `src/engines/` except where noted, anything under `src/parser/` except `resolver.ts:8,227`, any other conductor files.

### Pre-flight (run before α)
The audit's "zero callers", "tests-only", and "unused export" claims are time-stamped to the audit. Before starting α, re-run at HEAD of `worktree-pr3-hint-store`:
```
grep -rn "runCFGOptimization\|stabilizeStatic\|runAnalysisPass\|runMultiAnalysisPasses\|DFAStatementDriver" src/
```
If any production (non-test) caller has appeared since the audit, STOP and report — do not delete.

### Load-bearing invariants (must survive)
1. **Globally unique node ids** (asserted at `src/specialization/framework/persistent-worklist.ts:275`). γ relies on this.
2. **`pinSet.clear()` on throw** (`src/specialization/engine.ts:105`). δ must preserve this by extracting into `runPinned`.
3. **`deactivateAndTick(scope, threw)` asymmetry** (`src/specialization/framework/persistent-worklist.ts:309`) — success-path tick is suppressed on throw. Any `runPinned` helper must preserve this asymmetry.
4. **`observeCall` → call-count hints** — memoization's trigger. Do not break the observation dispatch path in persistent-worklist.ts:349-363.
5. **`ScopeTransformRule.safeOnStack` semantics** — allow-explicit at rule level. Do not touch in this round.
6. **Three-layer pin gate** (safeOnStack / canInstallOnStack / allowOnStack) — each gates a distinct concern. DEFER all three.

### Commit discipline
- One commit per step (α, γ, δ, ε1, ε2). Each commit stands alone and passes `yarn test` on its own.
- Commit messages: `refactor(specialization): α — drop dead fixpoint engines`, etc.
- Do NOT combine steps. If one step is blocked, stop and report.
- **Each step must be `git revert`-safe in isolation.** Before committing δ and ε1 (the two steps that touch evaluator/cross-cutting surface), mentally verify: reverting this commit alone restores a working tree. If not, the commit bundles too much — split it.

### Test discipline (critical)
- **Every deletion step starts by identifying or writing the invariant test** that proves the kept behaviour still holds. See each step's "Red tests" subsection.
- **Distinguish two test categories when reacting to failures:**
  - **Behaviour-encoding tests** (e.g., fib(20) memoizes, pinSet cleared on throw, lattice fixpoint converges): these are the spec. If they fail, the change is wrong — fix the change, never the test.
  - **Contract-encoding tests** (e.g., a test that constructs `HintStore` with a registry arg, or asserts `analysisModules` is a constructor parameter): these encode the *old* API. They MUST be rewritten to the new API. Call this out explicitly in the commit message (`test: update contract for γ HintStore rewrite`). Do not delete them silently.
- If a failure is ambiguous between these two categories, stop and report — do not guess.
- Do NOT weaken a behaviour-encoding test to unblock. Do NOT `--no-verify`. Do NOT skip.

---

## Step 1 — α prune: delete dead fixpoint engines

### Rationale
Two independent Kildall implementations predate Tier-1 of `PersistentWorklist` and were never removed. `runCFGOptimization` has **zero callers**. `stabilizeStatic` + DFA-driver stack is **tests-only**; the production claim at `src/tests/review-findings.test.ts:123` is stale.

### Red tests (no new test needed)
`PersistentWorklist`'s fixpoint behaviour is covered by `src/tests/convergence-benchmark.test.ts` and `src/tests/worklist-observations.test.ts`. These will continue to pass after deletion. Before starting, run:
```
yarn test -- convergence-benchmark.test
yarn test -- worklist-observations.test
```
Both must be green at HEAD.

### Deletions
- **File (full)**: `src/specialization/framework/dfa-driver.ts` — `DFAStatementDriver` (class, ~120 LoC), `runAnalysisPass`, `runMultiAnalysisPasses`, `stabilizeStatic`. The file becomes removable.
- **File (full)**: `src/tests/dfa-fixpoint.test.ts`.
- **In `src/specialization/framework/worklist.ts`**:
  - Delete `drainWorklist`, `drainAllAnalyses` (lines ~268–298).
  - Delete `runCFGOptimization` (lines 302–328).
  - **KEEP**: `makeSession`, `mergeInto`, `computeBlockIN`, `transferBlock`, `AnalysisSession` interface. These are used by `PersistentWorklist`.
- **Surgical removal** from `src/tests/transform-rules.test.ts`, `src/tests/const-analysis.test.ts`: remove only the `describe`/`it` blocks that exercise `stabilizeStatic` or `runAnalysisPass`. Do not touch blocks that exercise PersistentWorklist or raw lattice behaviour.
- **Surgical removal** from `src/tests/review-findings.test.ts:119-155` (the P2 block) and the stale comment at line 123 claiming `PySvmlEvaluator only runs runAnalysisPass`.
- **`src/specialization/index.ts`**: remove exports at lines 54–56 (`stabilizeStatic`, `runAnalysisPass`, `runMultiAnalysisPasses`, `MutableEnv` if no longer referenced — check), 65 (`runCFGOptimization`). Keep `MutableEnv` if PersistentWorklist uses it.

### Verification
- `yarn test` passes.
- `grep -r "runCFGOptimization\|stabilizeStatic\|runAnalysisPass\|runMultiAnalysisPasses\|DFAStatementDriver" src/` returns zero hits.
- `grep -r "drainAllAnalyses\|drainWorklist" src/` returns zero hits.

### LoC delta estimate
≈ **−640** (≈ −240 production, ≈ −400 test).

---

## Step 2 — γ collapse: HintStore → `Map<id, OptimizationHint>` + free fn

### Rationale
Node ids are globally unique (persistent-worklist.ts:275). Per-scope `HintStore` + per-store `registry` + `LatticeEquality` + `buildRegistry`-per-store machinery buys nothing for the two known hint fields. The roadmap's own resolved-gap note (L701-702) is inaccurate — two registry shapes coexist.

### Red tests
1. **Write first (must pass before and after)**: a test asserting field-level equality suppression on writes. `setHint(map, id, {type: someTypeLattice})` — calling twice with equal lattice values must return `false` on the second call. Place it in `src/tests/hint-store.test.ts` (or inherit from existing cases).
2. Existing `src/tests/hint-store.test.ts` structural-equality tests must continue to pass.

### Changes
- **Rewrite `src/specialization/framework/hint.ts`** (~123 → ~40 lines):
  - Keep: `OptimizationHint` type, `hintEquals` as a 15-line switch (see below). Delete: `LatticeEquality` interface, `DEFAULT_REGISTRY_ENTRIES`, `defaultRegistry()`, `buildRegistry`, registry field parameter.
  - New `hintEquals(a, b)` body: switch on field name — `type` uses `typeLatticeEquals`, `constVal` uses `constLatticeEquals`, `callCount` and `memoized` use `===`. Inline equality implementations from the lattice modules; do not route through a registry.
  - **New public API (decided, not a choice)**: keep `HintStore` as a class. `class HintStore { private map: Map<number, OptimizationHint>; getById(id): OptimizationHint | undefined; setById(id, hint): boolean }`. No registry field, no `analysisModules` constructor parameter. Storage stays **per-`FunctionUnit`** — do NOT promote to a module-scope single map in this step (see note below).
- **`src/specialization/framework/function-unit.ts`**: remove `analysisModules` parameter from `buildFunctionUnits` (line ~90) and from `ScopeDiscoveryVisitor` constructor. HintStore construction no longer takes modules.
- **`src/specialization/framework/interfaces.ts`**: remove `extends LatticeEquality` from `AnalysisModule`. Concrete modules already declare `name` and `latticeEquals` directly; structural typing covers the interface.
- **`src/specialization/framework/persistent-worklist.ts`**: `hintsFor` (lines ~271-291) **survives unchanged** in this step. The linear scan over `nodeUnitCache` is load-bearing precisely because `HintStore` is per-unit — that per-unit isolation is what keeps speculative/OSR rollback scoped to a unit rather than polluting sibling units. Collapsing to a single module-scope `Map<number, OptimizationHint>` is a *storage-model change*, not a registry collapse, and needs its own red test for per-unit isolation under OSR failure. **Defer to a separate future step.** The Phase 2 prosecutor's "no red test against a single map" is absence-of-evidence; treat it as coverage gap, not safety.
- Update call sites in `src/specialization/type-analysis/analysis.ts`, `const-analysis/analysis.ts`, `memoization-analysis/analysis.ts`, `transforms/*.ts`, and any test that constructs a `HintStore` with registry entries.

### Verification
- `yarn test` passes.
- `grep -r "LatticeEquality\|DEFAULT_REGISTRY_ENTRIES\|buildRegistry" src/` returns zero hits.
- `grep -r "latticeEquals" src/` returns only declarations on concrete modules (`TypeAnalysisModule`, `ConstAnalysisModule`, `MemoizationAnalysisModule`), not interface-level.

### LoC delta estimate
≈ **−90** (lower than original −110 because `hintsFor` is no longer simplified; that delta moves to a future storage-model step).

---

## Step 3 — δ shrink: `SpecializationEngine` → `runPinned()` helper

### Rationale
The class centralizes exactly one real invariant (`pinSet.clear()` on throw). Everything else is pass-through. `createReactiveOptimization` is a one-line factory. `createAnalyses`/`createTransforms` are trivial arrays with no configuration points.

### Red tests (write first — these must fail before the step and pass after)
1. **`pin-leak-blocks-next-evaluation` regression test** — place in `src/tests/engine-throw-cleanup.test.ts`. Assert on **observable behaviour**, not private state:
   - Construct a conductor with `PyCseEvaluator` (shared across both evaluations — a fresh-per-evaluation worklist would paper over the leak and invalidate the test).
   - Evaluation 1: run a chunk that throws a Python error *mid-function-call* on a `FunctionDef` scope that, in a cold run, would be eligible for an OSR swap / transform installation on its second invocation.
   - Evaluation 2: run a chunk that invokes that same `FunctionDef` normally and is expected to trigger the swap/transform.
   - Assert: the expected swap/transform **fires in evaluation 2**, identical to the cold-reference evaluation (run in a sibling test with a fresh conductor as the baseline).
   - Rationale: a leaked pin would *block* the swap. This is what the `pinSet.clear()` semantics actually guards — a private-field assertion could pass while the behaviour is broken (or vice versa). If you cannot construct a case where a leaked pin changes observable output, the invariant may already be vestigial — STOP and report before deleting `engine.ts`.
2. **`runPinned` tick-suppression-on-throw test**: invoke `runPinned(worklist, null, rootScope, pinSet, () => { throw X; })`. Assert no success-path tick fires (mirrors `deactivateAndTick(scope, threw)` at persistent-worklist.ts:309).

### Changes
- **Create `src/specialization/run-pinned.ts`**:
```ts
import type { PersistentWorklist } from './framework/persistent-worklist';
import type { OSRCoordinator } from './framework/osr';

export function runPinned<T>(
  worklist: PersistentWorklist,
  coordinator: OSRCoordinator | null,
  rootScope: FileInput | FunctionDef,
  pinSet: Map<FileInput | FunctionDef, number>,
  fn: () => T,
): T {
  coordinator?.start();
  try {
    return worklist.withActiveScope(rootScope, fn);
  } catch (e) {
    pinSet.clear();
    throw e;
  } finally {
    coordinator?.stop();
  }
}
```
Verify by inspection that this preserves: (a) the `pinSet.clear()` on throw (currently `engine.ts:105`), (b) the `withActiveScope` finally-block ordering that suppresses success-path tick on throw (currently `persistent-worklist.ts:300-324`).

- **Delete `src/specialization/engine.ts`**. Remove its export from `src/specialization/index.ts`.
- **Delete `src/specialization/pipeline-config.ts`**. Inline the two 3-element arrays at their two call sites.
- **Delete `createReactiveOptimization`** from `src/specialization/index.ts` (and the test-convenience `@internal` tag). Tests inline the constructor call.

- **Update the three evaluators**:
  - `src/conductor/PyCseEvaluator.ts` (around line 88) and `src/conductor/PySvmlEvaluator.ts` (around line 18): replace `new SpecializationEngine(...)` + `engine.run(fn)` with direct construction of `PersistentWorklist` + `runPinned(worklist, null, rootScope, pinSet, fn)`.
  - `src/conductor/PySvmlJitEvaluator.ts` (around line 31): same pattern but construct `OSRCoordinator` + `SVMLSwapStrategy`, wire via `worklist.subscribe(strategy.onChange.bind(strategy))` (or the current `coordinator.start()` ceremony if kept), then `runPinned(worklist, coordinator, rootScope, pinSet, fn)`.
- **Update `scripts/dump-ast.ts:294`** to match.
- **Update all ≈13 test sites** currently calling `createReactiveOptimization(...)`: replace with explicit `new PersistentWorklist(ast, envs, [new TypeAnalysisModule(), new ConstAnalysisModule(), new MemoizationAnalysisModule()], [new DeadBranchEliminationRule(), new ConstantFoldingRule(), new MemoizationTransformRule()])`. Acceptable for tests to extract a local helper within the test file; do not resurrect a global factory.

### Verification
- New `pinSet-cleared-on-throw` test passes.
- `yarn test` passes in full. In particular:
  - `src/tests/svml-jit-*.test.ts`
  - `src/tests/osr-*.test.ts`
  - `src/tests/convergence-benchmark.test.ts`
- `grep -r "SpecializationEngine\|createReactiveOptimization\|createAnalyses\|createTransforms" src/` returns zero hits outside your new `runPinned` site and the old file removals.

### LoC delta estimate
≈ **−68** net (−90 engine.ts, −27 pipeline-config.ts, −6 factory, +~55 for runPinned helper + inlined constructors).

---

## Step 4 — ε re-seat (split into ε1 + ε2)

The original ε bundled four independent changes (observer extraction, `fireOnce` scheduler plumbing, `MEMOIZED_FIELD` latch removal, intrinsic rename). The intrinsic rename touches `parser/resolver.ts` and `engines/svml/builtins.ts` — a cross-cutting surface worth isolating. Split:

- **ε1**: observer + `fireOnce` + `MEMOIZED_FIELD` latch removal (all within `src/specialization/`).
- **ε2**: `memoHas`/`memoGet` → `memoLookup` intrinsic rename (crosses resolver + svml engine).

Commit order: ε1 then ε2. Each must pass `yarn test` independently.

### Shared rationale
`MemoizationAnalysisModule` + `MemoizationVisitor` are SELF-93 profile machinery forced through a Kildall `AnalysisModule` slot; the visitor and all lattice ops are inert. `MemoizationTransformRule` is non-monotone (Class-6) smuggled through Class-5 via the `MEMOIZED_FIELD` self-latch in its `matches` predicate. `memoHas` duplicates `memoGet + MISS` at every cache-hit call site.

### Pre-flight question (resolve before ε1)
The plan previously said "keep the `MEMOIZED_FIELD` annotation write in `apply()` — downstream tooling may inspect it." That is speculative. Before ε1:
```
grep -rn "MEMOIZED_FIELD\|'memoized'\|\"memoized\"" src/ scripts/
```
If no non-test reader outside `transforms/memoization.ts` exists, **delete the annotation write too**. Do not keep speculative metadata. Record the finding in the ε1 commit message.

---

### ε1 — observer + fireOnce + latch removal

#### Red tests (write first — must fail before, pass after)
1. **`OneShotScopeRule` skip-after-fire test**: construct a worklist with a rule marked `fireOnce: true` and a scope that is **known to re-tick** (drive a second observation that in the pre-change code would re-enter `processScopeTransform` for that scope — e.g., a second call-count increment crossing the threshold a second time, or an explicit `markScopeDirty` if the harness exposes one). Instrument the rule with a `matches` call counter. After the first apply, trigger the second tick. Assert counter == 1. Fails if either the scheduler `fireOnce` short-circuit OR the latch-removal is wrong, AND fails if the scope does not actually re-tick (avoiding the false-pass where no second tick ever happens).
2. **`CallCountObserver` dispatch test**: register a `CallObserver` on the worklist. Trigger `observeCall(callee, callsite)`. Assert the observer's `onCallObservation` fires. Additionally: register a stub `AnalysisModule` and assert its (non-existent, post-change) `onCallObservation` path is not invoked — i.e., the dispatch no longer flows through `analyses`. Verify by grep that `AnalysisModule` interface no longer declares `onCallObservation`.
3. Existing `src/tests/memoization.test.ts` fib(20) + purity tests must continue to pass.
4. Existing `src/tests/memoization-svml.test.ts` must pass.

#### Changes
- **Add to `src/specialization/framework/interfaces.ts`**:
```ts
export interface CallObserver {
  onCallObservation(callee: FunctionDef, callsite: Call): void;
}
export interface OneShotScopeRule extends ScopeTransformRule {
  readonly fireOnce: true;
}
```
- **Remove `onCallObservation` from `AnalysisModule`** (same file). The interface keeps only lattice ops + transfer.
- **Modify `PersistentWorklist`**:
  - Add `private callObservers: CallObserver[] = []` and `addCallObserver(obs: CallObserver)`.
  - In `observeCall` dispatch (`persistent-worklist.ts:349-363`), iterate `callObservers` instead of filtering `analyses` for `onCallObservation`.
  - Add `private firedOneShotRules: Map<Scope, Set<ScopeTransformRule>>` field. In `processScopeTransform`, check `rule.fireOnce && firedOneShotRules.get(scope)?.has(rule)` — short-circuit. After successful apply, insert.
- **Rewrite `src/specialization/memoization-analysis/analysis.ts`**:
  - Delete `MemoizationVisitor`, `MemoizationAnalysisModule`.
  - Add `CallCountObserver` class implementing `CallObserver`; increments `CALL_COUNT_FIELD` on each `onCallObservation`.
  - Keep `CALL_COUNT_FIELD`, `MEMOIZATION_THRESHOLD`. `MEMOIZED_FIELD`: keep or delete per the pre-flight grep result.
- **Modify `src/specialization/transforms/memoization.ts`**:
  - Mark rule `readonly fireOnce = true as const`.
  - Delete the `MEMOIZED_FIELD` check in `matches()` (line ~58).
  - `apply()`: intrinsic calls stay on the OLD names (`__memo_has`/`__memo_get`) in ε1. The rename is ε2.
- **Update registration**: where `createAnalyses` used to include `MemoizationAnalysisModule`, the evaluator calls `worklist.addCallObserver(new CallCountObserver(hints))`. Adjust Step 3's inlined constructor sites.

#### ε1 verification
- `yarn test` passes.
- `grep -rn "MemoizationVisitor\|MemoizationAnalysisModule" src/` returns zero hits.
- `AnalysisModule` interface no longer declares `onCallObservation`.

#### ε1 LoC delta
≈ **−70** net.

---

### ε2 — intrinsic rename (`memoHas`/`memoGet` → `memoLookup`)

#### Red tests
1. **`memoLookup` MISS/hit test** in `src/tests/memoization-runtime.test.ts`: `memoLookup(id, args)` returns `MEMO_MISS` sentinel on miss, stored value on hit.
2. Existing memoization tests (`memoization.test.ts`, `memoization-svml.test.ts`) must pass end-to-end after the rename propagates through resolver + SVML builtins.

#### Changes
- `src/specialization/memoization-analysis/runtime.ts`:
  - Delete `memoHas`.
  - Rename `memoGet` → `memoLookup`.
  - Remove `__memo_has` from `MEMO_INTRINSIC_NAMES`; rename `__memo_get` → `__memo_lookup`.
- `src/specialization/transforms/memoization.ts` `apply()`: emit `const v = __memo_lookup(...); if (v !== __MEMO_MISS) return v;` in place of the `__memo_has`/`__memo_get` pair.
- `src/parser/resolver.ts` (lines 8, 227): update intrinsic names.
- `src/engines/svml/builtins.ts:5-7`: bind the renamed intrinsic. Verify both CSE and SVML evaluation paths.

#### ε2 verification
- `yarn test` passes.
- `grep -rn "__memo_has\|memoHas\b\|__memo_get\b" src/` returns zero hits.
- `grep -rn "__memo_lookup\|memoLookup" src/` returns the expected sites (runtime, transform, resolver, builtins).

#### ε2 LoC delta
≈ **−25** net.

### Combined ε LoC delta
≈ **−95** net (ε1 + ε2).

---

## Step 5 — β DEFER (no code changes this round)

### Why nothing changes
The three-layer pin gate (`safeOnStack` / `canInstallOnStack` / `allowOnStack`) compensates for the absent Truffle Assumption/deopt mechanism. Each layer gates a distinct concern; the Phase 2 prosecutor's "canInstallOnStack is a synonym for safeOnStack" verdict was incorrect (corrected at adjudication — `canInstallOnStack` is deny-by-default via optional-chain at `osr.ts:163`, whereas `safeOnStack` is allow-explicit at the rule level). Removing any one piece without replacing the missing mechanism reintroduces the livelock class (fib-recursion mid-execution).

The `<Delta>` generic on `StateDeltaStrategy` and `InPlaceASTStrategy`'s no-op shape become non-degenerate under a possible descriptor refactor (see `docs/specialization-audit.md` §5(b)). Premature collapse forces regrowth if that refactor ever lands.

### Documentation gates (for a future PR that does prune β)
If a future PR proposes pruning any β noun, it must include:
1. **Explicit deny-by-default at `osr.ts:163`** — replace the optional-chain (`!this.strategy.canInstallOnStack?.(key)`) with an explicit check. Add a unit test asserting `canInstallOnStack undefined → deny`.
2. **Site-level documentation** at each of the three pin-gate layers (`interfaces.ts:67`, `osr.ts:87`, `svml-interpreter.ts:129`): what concern the layer gates, what would break if removed without replacement, the descriptor-refactor alternative.
3. **Regression test**: pin a scope, assert SVML installs still fire via the strategy path (prove the gate does not over-block). Extend `src/tests/osr-coordinator.test.ts` or `src/tests/svml-jit-runtime-refinement.test.ts`.

### Nothing in this PR
Do NOT delete `OSRCoordinator`, `StateDeltaStrategy`, `InPlaceASTStrategy`, or any of the three gate flags.

---

## Step 6 — Post-cleanup verification

After α/γ/δ/ε1/ε2 commits are all in, run:

1. **Full test suite**: `yarn test`. All green. This is the authoritative gate.
2. **Grep audit — must return zero hits (authoritative behavioural gate)**:
   - `runCFGOptimization|stabilizeStatic|runAnalysisPass|runMultiAnalysisPasses|DFAStatementDriver|drainAllAnalyses`
   - `LatticeEquality|DEFAULT_REGISTRY_ENTRIES|buildRegistry`
   - `SpecializationEngine|createReactiveOptimization|createAnalyses|createTransforms`
   - `MemoizationVisitor|__memo_has|memoHas\b|__memo_get\b`
3. **Grep audit — must return non-zero hits (these survive)**:
   - `PersistentWorklist`
   - `OptimizationHint`
   - `OSRCoordinator|StateDeltaStrategy|InPlaceASTStrategy` (β deferred)
   - `safeOnStack|canInstallOnStack|allowOnStack` (β deferred)
   - `isPureFunctionDef`
   - `memoLookup|memoPut` (ε2 renamed intrinsics)
4. **LoC sanity check (indicative only, NOT a gate)**: aggregate ≈ **−870 to −950 LoC** across α/γ/δ/ε1/ε2.
   - If substantially **smaller**: check whether dead exports or test files were missed.
   - If substantially **larger** (e.g., < −1050): you likely over-pruned — STOP, review diffs, confirm no load-bearing code was deleted that the grep audit failed to catch.
   - Do not gate merge on this number. Behaviour (tests + grep audit) is the gate.
5. **Optimization roadmap flag** (explicit exception to §0 "do not touch `docs/`"): add one line at the top of `docs/optimization-roadmap.md` stating the doc is "ideation trace, partially superseded by `docs/specialization-audit.md` (2026-04)". Do NOT rewrite the roadmap; it is historical. This is the *only* permitted `docs/` edit.

---

## 7. Handoff notes

- **Work in order** α → γ → δ → ε1 → ε2. Each step commits independently.
- **Do not bundle steps.** Each stands alone, is `git revert`-safe, and passes `yarn test` on its own.
- **Do not start Path (b).** Completing Truffle Assumptions / descriptor refactor / per-site SpecializationCache is deliberately out of scope.
- **Preserve the load-bearing invariants listed in §0.** The `pinSet.clear()` on throw is the subtlest; the Step 3 red test is the guardian.
- **Do not modify** `src/conductor/svml-swap-strategy.ts` (β deferred). Do not modify `src/engines/svml/svml-interpreter.ts` except to follow intrinsic renames in ε.
- **Do not modify** `docs/` except to add the one-line note in Step 6.
- **Re-read `docs/specialization-audit.md` §3 and §4** before starting each step — it names which pattern each noun serves and why the bandaid exists. The pattern context prevents accidental regression.
- **If blocked**: stop, do not force. Report the specific invariant the change would violate; do not weaken a test to unblock.
- **If `yarn test` fails**: diagnose root cause. Do not `--no-verify`. Do not skip tests.

---

## 8. Summary LoC table

| Step | Net LoC | Key file changes |
|---|---|---|
| α | ≈ −640 | `framework/worklist.ts` (prune), `framework/dfa-driver.ts` (delete), `tests/dfa-fixpoint.test.ts` (delete), stale test blocks |
| γ | ≈ −90 | `framework/hint.ts` (rewrite), `framework/function-unit.ts` (param), `framework/interfaces.ts` (interface). `hintsFor`/storage-model change deferred. |
| δ | ≈ −68 | `engine.ts` (delete), `pipeline-config.ts` (delete), `index.ts` (factory), three evaluators (inline), new `run-pinned.ts` |
| ε1 | ≈ −70 | `memoization-analysis/analysis.ts` (rewrite to `CallCountObserver`), `transforms/memoization.ts` (fireOnce + latch removal), `persistent-worklist.ts` (observer list + fireOnce), `interfaces.ts` (new interfaces) |
| ε2 | ≈ −25 | `memoization-analysis/runtime.ts` (merge `memoHas`+`memoGet` → `memoLookup`), `transforms/memoization.ts` (emit rename), `parser/resolver.ts` (rename), `engines/svml/builtins.ts` (rename) |
| β | 0 | DEFER |
| **Total** | **≈ −893** (indicative, not a gate) | |
