# `src/specialization/` cleanup plan (round 3)

Execution plan accompanying `docs/specialization-audit.md`. Four work items land; one is deferred; one is no-op.

## Sequencing

1. **C** — docs cleanup (landed as part of this memo + existing working-tree edits to `compilation-flow.md`).
2. **D** — relocate `ScopeIndexMap`. Mechanical.
3. **F** — delete `HintStore.eq` callback + dedupe path. Small focused diff.
4. **E** — rewrite purity analysis as a real intraprocedural MOD dataflow. Separate PR.
5. **A** — deferred; file as "wire JIT observer sink through `AnalysisPass.observeValue` / `mergeIntoHint`, then re-prosecute hook ceremony." Do not delete hooks speculatively.
6. **B** — no action.

---

## D — Relocate `ScopeIndexMap`

**Move:** `src/specialization/framework/scope-index-map.ts` → `src/engines/svml/scope-index-map.ts`.

**Update imports:**
- `src/engines/svml/svml-compiler.ts:6`
- `src/tests/interpreter-replace-program.test.ts:191`
- `src/tests/svml-stable-indices.test.ts`
- `src/specialization/index.ts` — remove re-export if present (verify with grep).

**Verification:** `yarn test` green; `rg "framework/scope-index-map" src/` returns zero hits.

---

## F — Delete `HintStore.eq` callback

**Files:**
- `src/specialization/framework/hint.ts` — drop `eq` constructor parameter; remove the equality guard in `setById`; every write stores unconditionally.
- `src/specialization/framework/function-unit.ts:105` — drop the `this.hintEq` argument at the construction site.
- `src/specialization/framework/worklist.ts:328` — delete the `hintEq` closure and the field holding it. Keep `hintFieldsEqual` and `analysesByName` (used by stabilization/convergence).
- `src/tests/svml-observation.test.ts:39`, `src/tests/observe-loop.test.ts:36`, `src/tests/cse-hint-visualization.test.ts:34` — change `new HintStore(() => false)` to `new HintStore()`.

**Verification:** `yarn test` + `yarn tsc --noEmit` green; `rg "hintEq|new HintStore\(.*=>" src/` returns zero hits.

---

## E — Rewrite purity as intraprocedural MOD dataflow (LANDED)

Target architecture: Banning POPL '79 §§2–3 / Cooper-Kennedy PLDI '88 §3, intraprocedural. Two shape constraints surfaced during implementation and narrowed the design — see §E Notes below.

**Lattice** (rewrite `src/specialization/purity-analysis/lattice.ts`):

```
PurityFact = {
  mod:     BitSet<slotIndex>,
  escapes: BitSet<slotIndex>,
  throws:  boolean,
  yields:  boolean,
  calls:   CLEAN | WHITELISTED | IMPURE_USER | UNKNOWN
}
```

Join at CFG merge: pointwise set-union on BitSets, OR on flags, lattice join on `calls`. Top = all-unknown; bottom = all-clean / empty sets.

**Transfer functions** (rewrite `src/specialization/purity-analysis/analysis.ts`):

- `Assign(local, rhs)` — union rhs's expression fact into path fact; add local slot to `mod`.
- `Assign(subscript|attr, rhs)` — add containing-object slot to `escapes` if non-local.
- `Call(callee, args)` — `calls` joins with `WHITELISTED` if callee in memo-safe whitelist, else `IMPURE_USER` or `UNKNOWN`. No interprocedural summary propagation in this cycle.
- `Raise` — set `throws`.
- `Yield` — set `yields`.
- `If` / `While` / `For` / `Try` — delegated to CFG driver; per-path facts flow to join at merge blocks.

**`PurityScopePass` shrinks** to an ~10-line reader: pick up exit fact, derive `hint.pure = mod ⊆ locals ∧ escapes == ∅ ∧ !throws ∧ !yields ∧ calls ∈ {CLEAN, WHITELISTED}`. No more structural fold.

**Monkey patches retired** (listed in audit memo §2): `stmtPure` recursion, self-call exemption, unconditional `Call→IMPURE`, unconditional `List/Subscript→IMPURE`, framework-conformance dead fields become driver-used fields.

**Consumer** (`src/specialization/transforms/memoization.ts:56`) unchanged; still reads `hint.pure`. Parity check required.

**Test extension** (`src/tests/purity-analysis.test.ts`):
- Discriminator case: `def f(x): y = 0; if x > 0: y = 1; else: y = 2; return y` classifies as pure.
- Loop-local write: `def g(n): s = 0; for i in range(n): s = s + i; return s` classifies as pure.
- Try/except with local-only writes — pure if no `raise`.
- Write-to-nonlocal via escape — impure.
- Call to whitelisted builtin — pure; call to user fn — impure (intraprocedural verdict).

**Verification:** extended tests green; memoization fires on branchy-pure functions (capability gain vs. current); analysis time stays O(E · slots) with worklist convergence counter as regression guard.

### §E Notes (post-landing)

The landed shape differs from the spec above in two deliberate ways:

1. **No `AnalysisPass` promotion.** `MutableEnv<L>` is a per-slot scalar-lattice env; a block-level `PurityFact` does not fit as `AnalysisPass<L>` without extending the driver to thread a second transfer channel. Extending the driver just to move this one pass into it is scope creep with no other beneficiary. `PurityScopePass` owns its own CFG walk and FIFO worklist. `interfaces.ts:142` already names "purity summaries" as a `ScopePass` use case, so the pass lives where the code already said it belongs. Side effect: the dead framework-conformance fields on the old `PurityEffectAnalysis` (`mergeKind`, `direction`, `top`, `bottom`, `join`, `meet`, `leq`) are gone along with the class, which is what the prosecution targeted.
2. **Fact fields pruned to match the grammar.** This AST has no `Raise`, `Yield`, or `Try`/`Except`, and no attribute-store target in `AssignTarget`. `yields` has zero sources; `throws` has one source (`assert`); attribute-store is not expressible. The landed fact is `{ mod: Set<slot>, calls: Clean|Whitelisted|Impure, impure: boolean }` where `impure` is the sticky OR of every "definitely-disqualifying" effect the grammar can actually produce: nonlocal/global read or write, subscript-store, `assert`, `lambda`, `List` literal, nested `FunctionDef`, `Starred`, `Global`, `NonLocal`, `FromImport`, bare `SimpleExpr`.

**Escape model.** The spec's "add containing-object slot to `escapes` when non-local" rule as literally written would misclassify `def f(xs, i): xs[i] = 1` as pure (parameter `xs` is a local slot but aliases a caller-owned object). Without a true escape analysis, the landed rule treats every subscript-store as impure. This preserves parity with the prior code and is the correct conservative verdict; a sharper rule is a follow-up blocked on escape analysis.

**Capability gains.** Two wins vs. the prior syntactic fold:
- Whitelisted builtins (`range`, `len`, `abs`, `min`, `max`, `int`, `float`, `str`, `bool`, `round`) no longer force calls to `IMPURE`. `def f(n): s=0; for i in range(n): s=s+i; return s` now classifies pure.
- Subscript-read is pure (only subscript-*store* is disqualifying). `def f(xs, i): return xs[i]` now classifies pure.

`List` literal and `Starred` remain impure pending an escape model.

---

## A — Deferred (JIT observer wiring)

Follow-up issue body:

> `AnalysisPass.observeValue` / `mergeIntoHint` have zero production callers today; only `src/tests/analysis-observe-value.test.ts` exercises them. The JIT evaluator does not currently wire a runtime observation sink through these hooks. When it does, the test-only methods become live — at which point re-prosecute the `AnalysisPass` interface shape (consider whether `ObservingAnalysis` should split from `AnalysisPass`, whether the dead `bottom()` / pass-level `join()` can shed, etc.). Do not delete speculatively in the meantime.

---

## Critical files

| Cluster | Files |
|---|---|
| C | `docs/specialization-audit.md`, `docs/compilation-flow.md` |
| D | `src/specialization/framework/scope-index-map.ts` → `src/engines/svml/`, `src/engines/svml/svml-compiler.ts`, `src/tests/interpreter-replace-program.test.ts`, `src/tests/svml-stable-indices.test.ts`, `src/specialization/index.ts` |
| F | `src/specialization/framework/hint.ts`, `src/specialization/framework/function-unit.ts`, `src/specialization/framework/worklist.ts`, three test files |
| E | `src/specialization/purity-analysis/lattice.ts`, `src/specialization/purity-analysis/analysis.ts`, `src/specialization/transforms/memoization.ts` (parity), `src/tests/purity-analysis.test.ts` |

## End-to-end verification

- `yarn test` green after each of C, D, F, E.
- `yarn tsc --noEmit` green.
- `rg safeOnStack src/` = 0 (already true pre-audit); `rg safeOnStack docs/` surfaces only historical-trace mentions after C.
- `rg "framework/scope-index-map" src/` = 0 after D.
- `rg "hintEq|new HintStore\(.*=>" src/` = 0 after F.
- Manual: run a branchy-pure Python fixture through the JIT evaluator; confirm memoization fires (E capability gain).
