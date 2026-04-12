# Specialization Cleanup — Execution Plan (round 2)

**Audience:** an agent executing the cleanup.
**Companion:** `docs/specialization-audit.md` — read sections 1 (patterns), 2 (monkey-patch inventory), 4 (open-question answers).
**Branch:** `worktree-pr3-hint-store`.

Sequenced per reviewer adjudication (2026-04-13). Each step is an independent commit with a falsifiable red test; green CI is the gate between steps.

---

## Step 1 — C7 · Observation-sink dissolution

**Blast radius:** `src/specialization/framework/persistent-worklist.ts`, `src/specialization/index.ts`, `src/engines/cse/context.ts`, `src/engines/svml/svml-interpreter.ts`, `src/tests/observation-sink-sync.test.ts`, `src/tests/svml-observation.test.ts`.

1. Inline `assertSyncObservationSink`'s body into `PersistentWorklist`'s constructor (pw.ts:248). Keep the `SINK_METHODS` tuple as a `const` inside the constructor.
2. Delete the `assertSyncObservationSink` export from `index.ts` and from `persistent-worklist.ts`.
3. Rewrite `observation-sink-sync.test.ts` as a constructor-level test: construct a `PersistentWorklist` with a stub that has one async method, assert the constructor throws. One `describe` block; net −50 LoC vs current 67.
4. Decide alias fate:
   - **Option A (recommended):** extract a nominal `interface ObservationSink` in `framework/observation-sink.ts`. Delete the `Pick<>` alias. `PersistentWorklist implements ObservationSink`. Test mocks keep working; no Pick-shadow.
   - **Option B:** delete the alias outright; rewrite `svml-observation.test.ts:78,122` mocks to construct a real `PersistentWorklist` over a minimal AST. Truly one-noun, higher churn.
5. Update `context.ts:3,46` and `svml-interpreter.ts:19,67,76` to the chosen type.

**Red test:** existing observe-loop, svml-observation, and operand-patch tests remain green. Constructor rejects `async` sink methods (new test).

**LoC delta:** −70 (A), −100 (B).

---

## Step 2 — C1+C8 · Scope-keyed state unification

**Blast radius:** `framework/persistent-worklist.ts`, `framework/function-unit.ts`, `run-pinned.ts`, `engines/cse/context.ts`, `engines/cse/environment.ts`, `conductor/PyCseEvaluator.ts`, `conductor/PySvmlJitEvaluator.ts`, `tests/utils.ts`, `tests/run-pinned.test.ts`.

Substeps must land in this order:

1. **Inline `deactivateAndTick`** into `withActiveScope`'s finally (pw.ts:342-357). Single caller; no API change.
2. **Drop `pinSet` constructor parameter** on `PersistentWorklist`. `activeScopes` becomes locally constructed (`new Map()`). Update `tests/utils.ts:37,44`.
3. **Add mutability header to `FunctionUnit`** (`framework/function-unit.ts:13-19`):
   ```ts
   /**
    * Immutable identity: funcAst, slotLookup.
    * Mutable state: hints, body (in-place splice), structuralVersion, pinCount.
    */
   ```
   Add `pinCount: number` field, initialized to 0.
4. **Redirect reads/writes** through the unit:
   - `persistent-worklist.ts:190,233,235,401-412,481,566,634` — replace `activeScopes.has/get/set/delete` with `this.units.get(key)!.pinCount`.
   - `engines/cse/environment.ts:181-199` — pin reads/writes go through `worklist.units.get(scope)?.pinCount`. Option: a minimal `pin(scope)/unpin(scope)` accessor on `PersistentWorklist` that delegates to the unit.
   - `run-pinned.ts:30` — `pinSet.clear()` becomes `for (const u of worklist.units.values()) u.pinCount = 0`.
5. **Delete external `pinSet` Map creation** from `PyCseEvaluator.ts:94-119` and `PySvmlJitEvaluator.ts:39-62`. Delete `pinSet?: Map<...>` from `context.ts:59` and from `runPinned`'s signature.

**Red test:** `run-pinned.test.ts:44` (pin-clear-on-throw), `run-pinned.test.ts:64` (balanced pin/unpin), queue-shape fingerprints on recursive fib (`memoization-svml.test.ts`). Any caller still holding a separate Map must fail compilation.

**LoC delta:** −35 to −50 across six files.

---

## Step 3 — C3 · Hint dispatch through registry

**Decision already taken (Q1):** wire `AnalysisModule.latticeEquals` through a registry.

**Blast radius:** `framework/hint.ts`, `framework/interfaces.ts`, `framework/persistent-worklist.ts`, all three `*-analysis/analysis.ts`, `tests/hint-store.test.ts`.

1. **Build the registry.** In `PersistentWorklist`'s constructor, build `this.analysesByName = new Map(this.analyses.map(a => [a.name, a]))`.
2. **Rewrite `hintEquals`** to consult the registry:
   ```ts
   function hintEquals(a, b, byName: Map<string, AnalysisModule>) {
     for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
       const av = (a as any)[name], bv = (b as any)[name];
       if (av === bv) continue;
       if (av === undefined || bv === undefined) return false;
       const mod = byName.get(name);
       if (!mod) return av === bv;
       if (!mod.latticeEquals(av, bv)) return false;
     }
     return true;
   }
   ```
3. **Thread the registry** into the equality callback given to `HintStore`. Smaller API: `HintStore` receives `(a,b) => boolean`, not the whole map.
4. **Delete `typeLatticeEquals` / `constLatticeEquals` re-exports** from `framework/hint.ts` once each module owns its equality internally.
5. **Q3 answer: keep the open index signature** on `OptimizationHint`. Dispatch is data-driven; honesty preserved.
6. **Dissolve `HintStore`** into `Map<number, OptimizationHint>` + free `setHint(map, id, hint, eq): boolean`. 12 call sites, mechanical rename.

**Red test:** `hint-store.test.ts` unchanged except for eq callback threading. Add a test that registers a fake module with a non-`===` equality and confirms the worklist terminates on a circular write (prevents S1 regression once dispatch is live).

**LoC delta:** −40.

---

## Step 4 — C2 · Dead strategy triangle

Runs after Step 2 (OSRStats inherited from C8 scope).

1. Delete `InPlaceASTStrategy` class (`framework/osr.ts:96-104`).
2. Delete `needsInstall` from `StateDeltaStrategy`; delete the early-return guard in `OSRCoordinator.onChange` (osr.ts:159).
3. Delete `OSRStats` interface; keep counter fields inline on `OSRCoordinator`.
4. Update `index.ts` to drop `InPlaceASTStrategy` / `OSRStats` re-exports.

**Red test:** SVML JIT end-to-end tests unchanged. CSE evaluator (already passes `coordinator: null`) unaffected.

**LoC delta:** −30.

---

## Step 5 — C6 · Runtime relocation + intrinsic dedup

1. **Move** `src/specialization/memoization-analysis/runtime.ts` → `src/runtime/memo.ts`. Update imports at `src/stdlib.ts:2388-2393`, `src/engines/svml/builtins.ts:4-8`, `src/resolver/resolver.ts:8`. Drop re-exports from `src/specialization/index.ts:90-98`.
2. **Delete `MEMO_MISS` export.** In `stdlib.ts:2437` replace the sentinel check with a `memoHas`-gate (SVML already uses this shape at `svml/builtins.ts:148`). Remove the sentinel import.
3. **MEMO_INTRINSIC_NAMES dedup.** Import the constant at `transforms/memoization.ts:39-41`, `stdlib.ts:2420/2430/2442`, `svml/builtins.ts:24-26`. Five sites share one source. (Alternative: inline at resolver, delete the constant. Recommend dedup — the three names ARE a stable ABI.)
4. **Optional rename:** `memoization-analysis/` → `memoization/` (drops the misleading suffix; `isPureFunctionDef` is explicitly not a DFA per SPEC-16).

**Red test:** `yarn test memoization memoization-svml` green.

**LoC delta:** −20.

---

## Step 6 — C4 · Barrel trim (last)

Must run *after* Steps 1–5 — each prior step removes symbols.

1. For each export in `src/specialization/index.ts`, run `rg -l <name> src/ | rg -v 'src/specialization/'`. Zero external hits → delete.
2. Expected dead/thin exports: `ExternalWorkItem`, `Subscriber`, `WorklistStats` (except `convergence-benchmark.test.ts`), `SlotInfo`, `SlotLookup`, `buildSlotTable`, `ExprTransformRule`, `StmtTransformRule` (tests already deep-import), `constLeq`/`constJoin`/`constMeet`, lattice bits not used in codegen, `MEMOIZATION_THRESHOLD`/`CALL_COUNT_FIELD`/`MEMOIZED_FIELD` (test-only), `InPlaceASTStrategy` (already gone Step 4), `MEMO_MISS` (already gone Step 5).
3. `yarn tsc --noEmit && yarn test` after each batch; restore any line whose removal triggers `has no exported member`.

**Red test:** green CI per batch.

**LoC delta:** −15 to −25.

---

## Deferred / independent prosecutions

Reviewer explicitly left these out of C1/C2/C8 scope. Retained as separate tickets:

**D1 — `canInstallOnStack` relocation to per-delta.** Fix: `delta.onStackSafe: boolean` computed by `computeDelta`. Whole-function → true, operand-patch → false, CSE void → N/A. The per-strategy flag is the wrong locus; moving it preserves the role distinction the reviewer named while correcting the noun it attaches to. Natural trigger: when operand-patch work lands and the TODO at `svml-swap-strategy.ts:54-60` comes due.

**D2 — `safeOnStack` state-reconciliation contract.** Require a `reconcileLiveFrame(unit, frame): void` sibling whenever `ScopeTransformRule.safeOnStack === true`. Today the flag documents an invariant the framework does not verify. Low urgency while `MemoizationTransformRule` remains the sole user; convert when a second user appears.

**D3 — Per-block dependency tracking (gap S1).** Replace `rebuildAndReseed(scope)` with dirty-block re-enqueue. In `persistent-worklist.ts::handleValueObservation`, when `hints.setById` returns true, build/consult `unit.nodeToBlock` and re-enqueue only that block + CFG successors. Retires `generation` stamping, `hasSafeOnStackScopeRule` cache + conditional-tick hack, and most of `OSRCoordinator.onChange`'s filter logic. Highest-impact gap; scope substantial.

---

## Doc hygiene (small separate PR)

- `docs/optimization-roadmap.md` — strip stale `SpecializationEngine` refs (lines 25, 214, 274, 489, 674); strip `createReactiveOptimization` (97, 367); fix SPEC-07 ownership text (86, 403) to reflect pinCount-on-FunctionUnit after Step 2; rewrite Decision 4 (512-524) as `CallObserver + ScopeTransformRule(fireOnce, safeOnStack)`.
- `docs/compilation-flow.md` — remove `SpecializationEngine` prose.
- `src/tests/utils.ts:31`, `src/tests/run-pinned.test.ts:3` — stale comments.

---

## Net LoC projection

| Step | LoC delta |
|---|---|
| 1 — C7 sink dissolution | −70 to −100 |
| 2 — C1+C8 pin unification | −35 to −50 |
| 3 — C3 hint dispatch + HintStore dissolution | −40 |
| 4 — C2 dead strategy triangle | −30 |
| 5 — C6 runtime relocation | −20 |
| 6 — C4 barrel trim | −15 to −25 |
| **Total** | **−210 to −265** |

Plus unquantified doc churn and deferred prosecutions D1/D2/D3.
