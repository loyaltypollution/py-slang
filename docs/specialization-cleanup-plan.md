# Specialization Cleanup — Execution Plan (round 2)

**Audience:** an agent executing the cleanup.
**Companion:** `docs/specialization-audit.md` — read sections 1 (patterns), 2 (monkey-patch inventory), 4 (open-question answers).
**Branch:** `worktree-pr3-hint-store`.

Sequenced per reviewer adjudication (2026-04-13). Each step is an independent commit with a falsifiable red test; green CI is the gate between steps.

**Progress (2026-04-13):** Step 2 landed across commits `03364f2` (C8 pinSet → FunctionUnit.pinCount) and `ed3c59b` (deactivateAndTick inlined). Remaining: Steps 1, 3, 4, 5, 6.

**Round-3 review-fold-ins (2026-04-13):**
- Step 3.2 — the proposed `if (!mod) return av === bv;` branch is reached only after an earlier `if (av === bv) continue`, so it's a dead check. Rewrite as `return false` for clarity (preserves γ's default-false behavior).
- Step 5 — LoC delta corrected to −10 (MEMO_MISS substep stricken; only move + dedup remain). Net-LoC table updated.
- Step 6 — `rg -l` in 6.1 is a candidate-generator, not an authority (misses `export * from` paths). `yarn tsc --noEmit` at 6.3 is the real gate. Do not delete based on rg alone.

---

## Anti-oscillation rule

This plan has gone through at least two cycles where one round's decisions were re-reversed by the next. Three cycles of oscillation have been adjudicated on 2026-04-13 (see verdicts inside Steps 3, 4, 5 below). **Before proposing a future plan-3 that reverses any decision here**, the agent MUST satisfy both:

1. **Consumer-count evidence.** Cite `file:line` of each non-test consumer of every symbol proposed for deletion. Absence of consumers must be structural (interface with no implementations, factory with no callers), not incidental ("none exist because a prior commit deleted them").
2. **Read-the-actual-code evidence.** Quote the specific line the plan claims has a particular shape. The round-2 MEMO_MISS failure (Step 5 below) was caused by asserting `svml/builtins.ts:148` was a "memoHas-gate shape" when reading the line showed it was already the sentinel shape.

A plan that cannot produce both (1) and (2) for a deletion must downgrade the action to "defer pending audit." Adopting this discipline is the only way out of simplification hell.

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

### Verdict (2026-04-13 synthesis — after γ)

Round-1 step γ (commit `1d85550`) collapsed `hintEquals` to a hard-coded `switch (name)` over `"type"` / `"constVal"` with `default: return false`. Round-2 Step 3 reverses that direction. The reversal is **correct** — γ was an intermediate state, not terminal — for three structural reasons:

1. **The axis is static vs dynamic dispatch.** Everything else in this step (class-vs-free-function for `HintStore`) is orthogonal noise. Both plans argue over the same line of code. The plan-author was flip-flopping on that single axis.
2. **`OptimizationHint` has an open index signature** (`[fieldName: string]: unknown`). A static switch with `default: return false` is a latent correctness bug for any *extension* field (non-listed lattice values whose structural equality differs from `===`). γ's `default: return false` masks this because the two known fields (`type`, `constVal`) are singletons whose structural equality coincides with `===` most of the time.
3. **`latticeEquals` is the odd-one-out.** The other module methods (`join`, `leq`, `top`, `meet`, `observeValue`, `mergeIntoHint`) already dispatch through the module instance. Every future reviewer who sees `latticeEquals` declared-but-unused in `interfaces.ts` and the two concrete modules will file the same bug — γ merely deferred that ticket.

γ's "zero callers" justification was self-fulfilling: γ deleted the registry *because* nothing consumed it, and the reason nothing consumed it was that γ also deleted the call site.

### Anti-oscillation caveat

**Split this step into two commits.** Round-2's substep 6 ("Dissolve `HintStore`") is orthogonal to substeps 1–5 (registry dispatch). Either storage shape (class or free function) works with either dispatch shape. Bundling risks a plan-3 cycle where the next agent questions the HintStore dissolution on its own merits.

### Blast radius

`framework/hint.ts`, `framework/interfaces.ts`, `framework/persistent-worklist.ts`, all three `*-analysis/analysis.ts`, `tests/hint-store.test.ts`.

### Substeps

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
6. **[DEFERRED — negative judgment after substeps 1–5 landed]** **Dissolve `HintStore`** into `Map<number, OptimizationHint>` + free `setHint(map, id, hint, eq): boolean`.

   **Consumer-count evidence (2026-04-13 post-Step-3):** `rg` finds **45 occurrences across 16 files** of `HintStore` constructor / `.get` / `.set` / `.setById` / `.getById`. The prior plan's "12 call sites, mechanical rename" estimate is off by ~4×.

   **Axis this turned on:** with C3 landed, the *eq callback* is the meaningful piece of state that distinguishes a write-through store from a raw Map. HintStore encapsulates that callback in one place. Dissolving pushes eq-threading to every write site — a burden shift, not a reduction. The class is already thin (≤30 LoC); the abstraction barrier earns its keep.

   **Skipped**, not deferred to "plan-3." Any future reversal must cite concrete consumer simplification that outweighs the 16-file eq-threading churn.

### Red test

`hint-store.test.ts` unchanged except for eq callback threading. **Add a test that registers a fake module with a non-`===` equality** and confirms the worklist terminates on a circular write that toggles a non-singleton extension-field lattice (prevents S1 regression once dispatch is live, AND falsifies γ's `default: return false` path).

### LoC delta

−40 for substeps 1–5. The HintStore dissolution is a separate accounting line.

---

## Step 4 — C2 · Dead strategy triangle

Runs after Step 2 (OSRStats inherited from C8 scope).

### Verdict (2026-04-13 synthesis — against apparent β reversal)

This is **not** a reversal of round-1's β-defer. It reads like one if you conflate scope; the two plans address disjoint concerns.

**Round-1's β-defer protected the pin-gate flags** — `safeOnStack` (interfaces.ts:67), `canInstallOnStack` (osr.ts:163), `allowOnStack` (svml-interpreter.ts:129). Round-1's livelock warning ("fib-recursion mid-execution") was specifically about removing any of those three, because they compensate for the absent Truffle Assumption/deopt mechanism.

**Round-2 Step 4 deletes the degenerate CSE strategy shell** — `InPlaceASTStrategy`, `needsInstall`, `OSRStats`. None of these are pin-gate flags. Concrete evidence:

- `InPlaceASTStrategy`: zero non-test consumers. Re-exported at `index.ts:30` but never constructed. CSE path passes `coordinator: null` to `runPinned` — the strategy never runs even if it existed.
- `needsInstall`: three uses total — declared (`osr.ts:50`), set to `false` on `InPlaceASTStrategy` (`osr.ts:110`), checked at `osr.ts:172`. If the only setter is deleted, the flag is unreachable.
- `OSRStats`: zero non-test consumers. Tests read individual counter fields (`osr-runtime-refinement.test.ts:87-89`, `svml-jit-runtime-refinement.test.ts:114-115`); inlining the shape loses nothing.

**Deliberately NOT deleted** (β-defer still holds): `OSRCoordinator`, `StateDeltaStrategy` interface (now single-impl), and all three pin-gate flags.

A future plan-3 cannot re-justify the deleted items without inventing a caller that does not exist.

### Substeps

1. Delete `InPlaceASTStrategy` class (`framework/osr.ts:96-104`).
2. Delete `needsInstall` from `StateDeltaStrategy`; delete the early-return guard in `OSRCoordinator.onChange` (osr.ts:159).
3. Delete `OSRStats` interface; keep counter fields inline on `OSRCoordinator`.
4. Update `index.ts` to drop `InPlaceASTStrategy` / `OSRStats` re-exports.

### Red test

SVML JIT end-to-end tests unchanged. CSE evaluator (already passes `coordinator: null`) unaffected. **Do NOT modify** `osr-coordinator.test.ts`'s pinned-scope assertions — those still exercise the pin-gate path that survives.

### LoC delta

−30.

---

## Step 5 — C6 · Runtime relocation + intrinsic dedup

### Verdict (2026-04-13 synthesis — substep 2 STRICKEN)

**Substep 2 ("Delete `MEMO_MISS` export") is factually wrong and must NOT be executed.** The justification cites `svml/builtins.ts:148` as proof that SVML "uses a memoHas-gate shape" — but that line IS the `MEMO_MISS` sentinel shape. Verified: cases 40 and 41 in `src/engines/svml/builtins.ts` both call `_memoLookup` and compare the result to `MEMO_MISS`. There is no memoHas-gate to point at.

Deleting `MEMO_MISS` forces one of:
- Re-introduce a separate `memoHas` JS helper (re-adding the double Map lookup that ε1/ε2 specifically eliminated — `cache.get(id)` then `inner.has(key)`, once for `memoHas`, then again for the subsequent `memoGet`/`memoLookup`).
- Use `undefined` as the miss sentinel (breaks because stored `undefined` / Python `None` after unwrap is a valid cached value and cannot be distinguished from miss).
- Out-parameter callback (allocation per call).

All three are regressions. `MEMO_MISS` is the only sentinel that distinguishes "absent" from "stored any JS value" in one Map traversal. Any future plan-3 that deletes it must first answer "how do you distinguish stored-None from miss in a single lookup?" — the answer is always "a fresh Symbol," i.e. re-inventing `MEMO_MISS`.

The real collapse win (going from two Python-level intrinsic calls `__memo_has` + `__memo_get` to a single `__memo_lookup`) is blocked at the **Python AST layer**, not the JS layer — it needs a Python-level `__memo_miss()` identity intrinsic or equivalent. That is where a future cleanup should focus.

### Substeps (substep 2 stricken)

1. **Move** `src/specialization/memoization-analysis/runtime.ts` → `src/runtime/memo.ts`. Update imports at `src/stdlib.ts:2388-2393`, `src/engines/svml/builtins.ts:4-8`, `src/resolver/resolver.ts:8`. Drop re-exports from `src/specialization/index.ts:90-98`. (Orthogonal to the sentinel question — safe.)
2. ~~**Delete `MEMO_MISS` export.**~~ STRICKEN per verdict above. Keep `MEMO_MISS` exported. Keep the sentinel imports at `stdlib.ts:2393` and `svml/builtins.ts:8`.
3. **MEMO_INTRINSIC_NAMES dedup.** Import the constant at `transforms/memoization.ts:39-41`, `stdlib.ts:2420/2430/2442`, `svml/builtins.ts:24-26`. Five sites share one source. The three names ARE a stable ABI — dedup, do not inline.
4. **Optional rename:** `memoization-analysis/` → `memoization/` (drops the misleading suffix; `isPureFunctionDef` is explicitly not a DFA per SPEC-16). Subsumed by substep 1 if that move also renames.

### Red test

`yarn test memoization memoization-svml` green. **Additionally:** grep audit `grep -n "MEMO_MISS" src/` — must show hits in `runtime.ts`, `stdlib.ts`, `svml/builtins.ts`, and the barrel export. If any of those four sites loses the import during the move, STOP — the sentinel is load-bearing.

### LoC delta

−10 (moves + dedup; the MEMO_MISS deletion that would have contributed −10 is stricken).

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
| 5 — C6 runtime relocation | −10 |
| 6 — C4 barrel trim | −15 to −25 |
| **Total** | **−200 to −255** |

Plus unquantified doc churn and deferred prosecutions D1/D2/D3.
