# Specialization Engine — Architectural Diagnosis (round 2)

**Subject**: `src/specialization/` (working tree, branch `worktree-pr3-hint-store`)
**Method**: descriptive inventory → roadmap archaeology → falsification prosecution → grep verification → forensic pattern diagnosis
**Verdict**: **INCOMPLETE, two load-bearing patterns half-wired.** Most "architecture sprawl" is either (a) residue of a dissolution that stopped one step short, or (b) a monkey patch that compensates for a missing step in an established pattern. Fix the gaps, the patches become redundant.

This memo supersedes the prior round's diagnosis. Scope narrower, prescriptions sharper.

---

> **Update (2026-04-13).** The 1b "lazy replacement / not OSR" diagnosis
> below has been executed: `OSRCoordinator`, `StateDeltaStrategy`,
> `SVMLSwapStrategy`, `SVMLDelta`, `OperandPatch`,
> `SVMLInterpreter.applyOperandPatches`, the `allowOnStack` arg on
> `patchFunction`, and `runPinned` were all deleted. The install seam is
> now a direct `Worklist.onScopeChanged((scope, unit) => ...)` callback,
> documented as **dispatch patching** (not OSR). The pin-set gate at
> `processTransform` is the single load-bearing pin layer; the prior
> "three-layer" model was dead-code redundant once the scheduler stopped
> notifying for pinned-and-unsafe scopes. S3 resolved by deletion;
> `safeOnStack` (S4) remains the one-bit trust flag, unchanged. Entries
> below that prescribe deletion (table row 1, survives row 3–4) read as
> now-executed; retained for historical trace.

---

## 1. What the literature already named

### 1a. Reactive/incremental monotone dataflow

> Kildall, *A Unified Approach to Global Program Optimization*, POPL '73 §3.
> Arzt & Bodden, *Reviser: Efficiently Updating IFDS-Based Analyses on Incremental Changes*, ICSE '14 §§3–4.
> Acar, *Self-Adjusting Computation*, CMU PhD (2005) §2.3 "Change propagation."

**Pattern core.** Modifiables (cells) → readers (computations that dereferenced a cell) → scheduler (re-runs dirty readers in topo order). On edit, the scheduler dirties *exactly* the readers whose inputs changed. Publication is at fact granularity, not region granularity.

**Our implementation.** Tier-1 `tick()` is textbook Kildall. Tier-2 is incremental *in intent* only: every write that flips a hint calls `rebuildAndReseed(scope)`, which discards all sessions for that scope and re-enqueues from the entry — a full re-analysis per invalidation. A `generation` stamp on queue items then discards stale work from prior rounds.

**Missing steps.**
- **S1** — No per-block dependency tracking. The scheduler does not know *which* block's transfer read the mutated hint, so it cannot dirty only the affected blocks.
- **S2** — Publication is coarse: subscribers receive `ReadonlySet<Scope>`, not the changed facts. Consumers filter at the subscriber (OSRCoordinator.onChange) using `canInstall`, `canInstallOnStack`, `needsInstall` — doing work the scheduler should have done by not notifying.

### 1b. Lazy / return-barrier replacement (not OSR)

> Hölzle, Chambers, Ungar, *Debugging Optimized Code with Dynamic Deoptimization*, PLDI '92 §4.2 (lazy replacement).
> Fink & Qian, *Adaptive Recompilation with On-Stack Replacement* (Jikes RVM), CGO '03 §§3–4 (true OSR with state mapping).
> Agesen, *GC Points in a Threaded Environment*, Sun TR-98-70 §§2–3 (safepoint vs yieldpoint).

**Pattern core.** Two distinct lines: (i) safepoint selection — *when* is thread state inspectable/patchable; (ii) on-stack vs off-stack replacement — do existing frames get rewritten (true OSR; needs a state-mapping function), or only future dispatches (lazy replacement; old frames run to completion against old IR).

**Our implementation.** `SVMLSwapStrategy` is **lazy replacement**: `CallFrame` captures IR by value, so old frames run to completion; future calls dispatch the new IR. `canInstallOnStack=true` is misleading — nothing is replaced on the stack. The single-threaded JS host makes "stop the world" trivial for us; the rule that genuinely mutates a live scope's body (`MemoizationTransformRule`) is closer to atomic-AST-rewrite-under-a-tree-walker, a mode the literature does not model.

**Missing steps / misshapes.**
- **S3** — `canInstallOnStack` is per-strategy but the actual distinction is per-*delta*. Whole-function recompile is on-stack-safe; operand patches are not. Strategy-level flag forces a TODO for when operand patches land.
- **S4** — `safeOnStack` (per-rule) is a one-bit trust flag standing in for the state-reconciliation contract the literature requires (Fink–Qian §4.2). Memoization gets away with it by accident of its rewrite shape; the framework does not check the precondition.

### 1c. Type-class dictionary dispatch (abandoned mid-wire)

> Wadler & Blott, *How to make ad-hoc polymorphism less ad hoc*, POPL '89 §§1–2.

**Pattern core.** Operation (`==`) resolved by dictionary lookup keyed on type / tag. Dictionary = instances; method = class member.

**Our implementation.** `AnalysisModule.name` is the dictionary key; `AnalysisModule.latticeEquals` (interfaces.ts:95) is the class method; the worklist owns the registry. The call site (`hintEquals`, hint.ts:35) bypasses the dictionary and hardcodes `switch(name) { case "type": … case "constVal": … default: return false }`. The interface method is declared on every module but never invoked.

**Monkey patch.** The switch + orphan method. SPEC-02's open-record contract is documentation drift — the index signature `[field: string]: unknown` is structurally open but operationally closed by the switch.

### 1d. Ghost interface — one-step-short dissolution

`ObservationSink = Pick<Worklist, "observeWrite" | "observeCall" | "activateScope" | "deactivateScope">`. Production callers always receive a real `Worklist`; the alias exists only so test mocks can present an object literal with four methods. This is the residue of the SPEC-05 dissolution that collapsed a 75-line interface file into a Pick — one step short of deleting the alias entirely.

### 1e. Scope-identity diffusion — owner dissolved, state externalized

`SpecializationEngine` was deleted in commit `efe8951`; its one invariant (`pinSet.clear()` on throw) became the free function `runPinned`. The pin-set became an external `Map<Scope, number>` shared by reference between the CSE evaluator, the SVML-JIT evaluator, and `Worklist.activeScopes`. `FunctionUnit` already owns a `Map<Scope, FunctionUnit>` as the unit registry and already holds mutable state (`hints`, body splicing, `structuralVersion`). The pin-count is the single remaining piece of per-scope state that isn't on the unit. Putting it there collapses three nouns (`pinSet`, `activeScopes`, and the parameter aliasing) into one field.

---

## 2. Monkey-patch inventory — which missing step does each compensate for?

| Escape hatch | Compensates for |
|---|---|
| `needsInstall=false` (StateDeltaStrategy) | S2 — subscriber filters what the scheduler should not have notified |
| `canInstallOnStack` (per-strategy) | S3 — wrong locus; safety is per-delta, not per-strategy |
| `safeOnStack` (per-rule) | S4 — one bit substituting for a `reconcileLiveFrame` hook |
| `ObservationSink` Pick<> alias | 1d — ghost interface, dissolution stopped short |
| `hasSafeOnStackScopeRule` cache + conditional tick in `observeCall` | S1 — non-incremental scheduler second-guesses when to flush |
| `generation` stamp on queue items | S1 — stale-item discrimination in a reseed-everything scheme |
| `hintEquals` switch + `default: return false` | 1c — dictionary bypassed, open-record contract broken |
| external `pinSet` param aliasing `activeScopes` | 1e — unit registry already exists; pin-count belongs on the unit |

Eight patches, four gaps. Closing S1 alone retires three of them.

---

## 3. Survives / delete / relocate

### Survives (earns keep)
- `Worklist` itself (Kildall + attempted incremental layer).
- `withActiveScope` — SPEC-15 structural owner of pin/tick/throw ordering.
- `OSRCoordinator` — real event-dispatch noun (kept distinct from data ownership).
- `StateDeltaStrategy` interface — SVMLSwapStrategy is real.
- `MemoizationTransformRule` — load-bearing; its `fireOnce` + `safeOnStack` flags encode a genuine non-monotone contract (pending S4 resolution).
- `ScopeIndexMap` — orthogonal SVML backend index.
- `isPureFunctionDef` — SPEC-16 carve-out; syntactic purity gate, not DFA.

### Delete (cluster verdicts accepted by reviewer)
- `deactivateAndTick` — 2-line private method, single caller; inline.
- `InPlaceASTStrategy` — zero production instantiations.
- `needsInstall` flag — closed setter/reader loop within the dead strategy.
- `OSRStats` interface — test-only consumer; inline counters on coordinator.
- `hintEquals` as separate export — single production caller (HintStore.setById); inline.
- `HintStore` class (conditional) — reduces to `Map<number, OptimizationHint>` + free `setHint` once the SPEC-02 dispatch is resolved.
- external `pinSet` Map aliasing — collapses into `FunctionUnit.pinCount`.
- `assertSyncObservationSink` — self-targeted; inline into constructor.
- `ObservationSink` alias — delete once test mocks resolved (see cleanup plan).
- `MEMO_MISS` export — replace with `memoHas`-gate pattern (SVML already uses this).

### Relocate
- `memoization-analysis/runtime.ts` → `src/runtime/memo.ts`. Consumers are stdlib + svml/builtins; it is not DFA infra.
- Optional: `memoization-analysis/` → `memoization/` (drops the "-analysis" suffix that miscategorizes `isPureFunctionDef`).

### Refine
- `MEMO_INTRINSIC_NAMES` — extend the constant to all 5 use sites (transform + 2 builtin registries + resolver + stdlib), or inline and delete. Current state (1 of 5) is DRY-by-halves.
- `index.ts` barrel — trim dead re-exports last, after upstream deletions land.

### Explicitly rejected by reviewer (left in place)
- `canInstallOnStack` — role-distinct from `canInstall` despite current body-equivalence. Left as an independent prosecution target; see S3 note.
- `safeOnStack` relocation onto FunctionUnit — category error (static rule contract, not scope state). Left as an independent prosecution target; see S4 note.

---

## 4. Answers to reviewer's open questions

**Q1 — Wire `AnalysisModule.latticeEquals` through a registry, or delete it?**
**Wire it.** Every other lattice operation (`join`, `leq`, `top`) already dispatches through the registered module; equality is the sole exception. Deleting `latticeEquals` maximizes surface-area inconsistency. The fix is mechanical: `hintEquals(a, b, modules)` receives the registry (already threaded through the worklist) and calls `modules.get(name)?.latticeEquals(av, bv) ?? (av === bv)`. The `default: return false` bug disappears; new analyses are a one-file edit.

Counter-case: if the set of analyses is closed forever (four and no more), deletion + canonical switch is simpler. The memoization additions and the roadmap's extensibility claim don't read as closed.

**Q3 — Close `OptimizationHint` to exhaustive dispatch, or document the openness?**
**Downstream of Q1, not independent.** If Q1 = wire, keep the open index signature — dispatch is data-driven, any field works, honesty preserved. If Q1 = delete/canonicalize, `OptimizationHint` **must** close (drop the index signature, enumerate fields, let TS exhaustiveness-check the switch). Leaving the index signature open alongside a closed switch is the worst cell of the matrix — it invites the extension the switch silently rejects.

**Q2 — Prosecute `canInstallOnStack` and `safeOnStack` separately?**
Yes, but with the forensic framing:
- `canInstallOnStack` — the real fix is moving the flag from strategy to *delta shape* (`delta.onStackSafe: boolean`, computed by `computeDelta`). Whole-function → true, operand-patch → false, CSE void → N/A. Today's per-strategy flag is a monkey patch for the wrong locus; the reviewer is right that the role is distinct from `canInstall`, and the fix preserves the distinction while moving it to the correct noun.
- `safeOnStack` — the real fix is `reconcileLiveFrame(unit, frame): void` as a required sibling method whenever `safeOnStack=true`. Today's one-bit flag documents an invariant the framework does not check. The reviewer's "static rule contract" framing is correct *as a placement judgment* (it doesn't belong on FunctionUnit); the prosecution it warrants is a shape change on `ScopeTransformRule`, not a relocation.

Both are substantive, both are independent of C1/C3/C6/C8, and both are lower priority than closing S1.

---

## 5. Priority

The ordering the reviewer gave (C7 → C1+C8 → C3 → C2 → C6 → C4) is correct for risk isolation. From the forensic lens, the **load-bearing gap** is S1 (per-block dependency tracking in the incremental layer); closing it retires `generation`, `hasSafeOnStackScopeRule`, and `needsInstall` as side effects, and the per-cluster sequencing the reviewer picked lands into a framework that no longer needs them.

See `docs/specialization-cleanup-plan.md` for step-by-step execution.
