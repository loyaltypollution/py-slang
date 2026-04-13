# Specialization Engine — Architectural Diagnosis (round 3)

**Subject**: `src/specialization/` (working tree, branch `worktree-pr3-hint-store`)
**Method**: descriptive inventory → roadmap archaeology → adversarial prosecution → grep verification → forensic pattern diagnosis
**Verdict**: **One subsystem misclassified, one indirection parametric-in-name-only, one citizenship error, and minor doc drift.** The prior round's `safeOnStack` / `canInstallOnStack` / `OSRCoordinator` / `runPinned` concerns are resolved by deletion (already landed on this branch). The remaining live defects are smaller but load-bearing.

This memo supersedes round 2. Round 2's findings that prescribed deletion are now executed; the ghost-field narrative is retained only in §6 as historical trace.

---

## 1. What this round found

Six suspect clusters went to prosecution. Two were defended, two authorized for trimming, one deferred on user-specific framing, one escalated to architecture rewrite.

| Cluster | Nouns | Verdict |
|---|---|---|
| A | `AnalysisPass.observeValue` / `mergeIntoHint` / `bottom()` / `join()` at pass level | **DEFER** — absent production callers look like a not-yet-wired JIT observer seam, not ceremony. Revisit when JIT observations land. |
| B | `ExprRewriteVisitor` / `TransformApplyVisitor` / `applyTransformPass` | **KEEP** — visitor pattern is idiomatic across codebase; prosecutor's LoC win marginal. |
| C | `safeOnStack` field + pin-count / `withActiveScope` / `runPinned` docs | **FIX** — code already deleted; `docs/specialization-audit.md` round 2 and `docs/compilation-flow.md` stale references cleaned. |
| D | `ScopeIndexMap` placement | **RELOCATE** — lives in `specialization/framework/` but only `engines/svml/svml-compiler.ts` + two tests consume it; zero framework-internal callers. |
| E | `PurityScopePass` / `lattice.ts` | **LANDED** — grammar review (no `Raise` / `Yield` / `Try`) + driver shape review (per-slot `MutableEnv<L>`) redirected the rewrite: `PurityEffectAnalysis` deleted, purity now lives entirely in `PurityScopePass` as a CFG-walking fixpoint with a block-level `PurityFact` (mod-set, call-purity, sticky impure). Capability gains: whitelist of memo-safe builtins (`range`, `len`, …), subscript-read is pure. Parity preserved on all prior pure/impure cases. |
| F | `HintStore.eq` callback | **DELETE** — parametric-in-name-only. Production always passes `hintFieldsEqual`; three tests pass `() => false` to defeat dedupe. No custom `eq` in the wild; no production site depends on write-suppression. |

---

## 2. Forensic naming — purity subsystem (cluster E)

The subsystem presents itself as a forward may-dataflow but is a single-pass structural tree walk. The `mergeKind` / `direction` / `top` / `bottom` / `join` / `meet` / `leq` declarations are framework-conformance with no CFG-driver behind them.

**Literature match.** Banning, *An Efficient Way to Find the Side Effects of Procedure Calls and the Aliases of Variables*, POPL '79 §§2–3. Cooper & Kennedy, *Interprocedural Side-Effect Analysis in Linear Time*, PLDI '88 §3. Lucassen & Gifford (POPL '88) and Talpin & Jouvelot (Inf&Comp '94) are candidate effect-system matches but diverge: effects are carried on side-tables, not on function types, and there is no polymorphism.

**Verdict: INCOMPLETE** application of Banning / Cooper-Kennedy, not INCORRECT. The direction is right; the structure is degenerate.

**Resolution (landed).** The rewrite deleted `PurityEffectAnalysis` and moved all purity logic into `PurityScopePass`, which now walks the scope's CFG directly with a block-level `PurityFact` = `{ mod: Set<slot>, calls: Clean|Whitelisted|Impure, impure: boolean }`. Two grammar / driver realities narrowed the target architecture from the literature spec:

- **Grammar.** This AST has no `Raise` / `Yield` / `Try`/`Except` and no attribute-store target. `throws` and `yields` as separate fact fields have no source statements; they collapse into the sticky `impure` flag alongside nonlocal writes, `lambda`, `List` literal, and disqualifying statement kinds. The only source of a "throws" fact in this grammar is `assert`.
- **Driver shape.** `MutableEnv<L>` in `framework/mutable-env.ts` is a per-slot scalar lattice; `transferStmt` can only write `env.set(slot, L)`. A block-level struct fact does not fit as `AnalysisPass<L>` without a framework extension whose only beneficiary would be this pass. The `ScopePass` interface (`framework/interfaces.ts:142`) already names "purity summaries" as its use case, so the rewrite lives there.

The dead `mergeKind` / `direction` / `top` / `bottom` / `join` / `meet` / `leq` framework-conformance fields on the old `PurityEffectAnalysis` are gone along with the class.

**Missing steps.**
- **S1 — per-slot MOD set.** Current lattice is `{PURE, IMPURE}`; a real MOD analysis tracks which slots a path definitely writes. Without this, assigning to a local collapses the same way as assigning to a nonlocal.
- **S2 — CFG join at merge points.** Currently `PurityScopePass.stmtPure` is a syntactic fold over the statement list. The join-at-merge is the job that the fold is compensating for.
- **S3 — interprocedural summary.** Currently every user-defined call is monolithically `IMPURE`. A real MOD analysis propagates callee summaries. For our single consumer (memoization) this is punt-able; a whitelist of builtins + intraprocedural precision is adequate until a second consumer lands.

**Monkey patches currently compensating:**
1. `PurityScopePass.stmtPure` structural recursion — compensates for missing CFG join (S2).
2. Self-call exemption in `exprPure` — compensates for missing SCC summary (S3).
3. Unconditional `Call → IMPURE` — compensates for missing callee summary (S3).
4. Unconditional `List` / `Subscript → IMPURE` — compensates for missing escape model (slot-locality is already decidable; the lattice can express it).
5. `mergeKind` / `direction` / `top` / `bottom` declarations — framework conformance with no driver behind them.

Target lattice in the rewrite:

```
PurityFact = {
  mod:     BitSet<slotIndex>,
  escapes: BitSet<slotIndex>,
  throws:  boolean,
  yields:  boolean,
  calls:   CLEAN | WHITELISTED | IMPURE_USER | UNKNOWN
}
```

A function is pure iff at function-exit: `mod ⊆ locals(self) ∧ escapes == ∅ ∧ !throws ∧ !yields ∧ calls ∈ {CLEAN, WHITELISTED}`.

Discriminator red test: `def f(x): y = 0; if x > 0: y = 1; else: y = 2; return y` must classify as pure. Current code may or may not; new code classifies as pure via CFG join on `mod = {y}` where `y` is local.

---

## 3. Parametric-in-name-only — `HintStore.eq` (cluster F)

`HintStore` constructor takes an `eq: (a, b) => boolean` callback. Verified call sites:

| Site | Value passed |
|---|---|
| `framework/function-unit.ts:105` (only production) | `this.hintEq` — closure over `Worklist.hintFieldsEqual` |
| `tests/svml-observation.test.ts:39` | `() => false` |
| `tests/observe-loop.test.ts:36` | `() => false` |
| `tests/cse-hint-visualization.test.ts:34` | `() => false` |

No production site ever passes anything but `hintFieldsEqual`. Tests pass the always-false comparator specifically to defeat the dedupe path — meaning no test *depends* on dedupe either. The callback is a seam with zero design variation and zero behavioural coverage.

**Resolution:** drop the callback, drop the write-suppression path in `setById`. `hintFieldsEqual` and the `analysesByName` registry survive as per-field equality oracles used elsewhere.

---

## 4. Citizenship error — `ScopeIndexMap` (cluster D)

Defined at `src/specialization/framework/scope-index-map.ts`. Consumers:

- `src/engines/svml/svml-compiler.ts:6, 57, 100, 189`
- `src/tests/interpreter-replace-program.test.ts:191` (test named "ScopeIndexMap wiring")
- `src/tests/svml-stable-indices.test.ts`

No other file under `src/specialization/` imports it. It is an SVML-backend index; placing it in `framework/` is a category error. Relocate to `src/engines/svml/scope-index-map.ts`.

---

## 5. Deferred — AnalysisPass observer hooks (cluster A)

Prosecutor established:
- `observeValue` and `mergeIntoHint` are only called by `src/tests/analysis-observe-value.test.ts`; no production caller.
- `bottom()` and `join()` at pass level are never called by the Kildall driver.
- `latticeEquals` has a single caller (`Worklist.hintFieldsEqual`).

Naively this reads as ceremony. But the real tell is architectural: the JIT evaluator does not yet wire a runtime observation sink through `observeValue` / `mergeIntoHint`. When it does, production callers will appear. Deletion now would be premature demolition of a partially-wired seam. Keep pending JIT observation wiring; re-prosecute then.

---

## 6. Historical trace (round 2 → round 3)

Round 2 prescribed deletion of `OSRCoordinator`, `StateDeltaStrategy`, `SVMLSwapStrategy`, `SVMLDelta`, `OperandPatch`, `SVMLInterpreter.applyOperandPatches`, the `allowOnStack` arg on `patchFunction`, `runPinned`, `withActiveScope`, `activateScope` / `deactivateScope`, and `safeOnStack`. All executed. The install seam is now a direct `Worklist.onScopeChanged((scope, unit) => ...)` callback, documented as **dispatch patching** (not OSR). LBD — interpreters re-read callee bodies at CALL time — is the single safety mechanism; no pin-count, no safepoint gate.

Round 2's §4 retraction ("hint equality is the only per-field cross-cutting op; gets one inlined walker and no exported symbol") stands; cluster F executes the final piece of that retraction (the vestigial `eq` callback through which the inlined walker was passed).

Round 2's "survives" list for `MemoizationTransformRule.safeOnStack` is superseded: no rule sets `safeOnStack` and the framework does not read it. The field is gone from `ScopeTransformRule`.

---

## 7. Priority

Execution order from the accompanying cleanup plan: **C** (doc hygiene; this memo is the C-deliverable for the audit doc) → **D** (mechanical relocation) → **F** (callback deletion; small diff) → **E** (purity rewrite; separate PR). **A** filed as follow-up blocked on JIT observation wiring. **B** no action.

See `docs/specialization-cleanup-plan.md` for step-by-step execution.
