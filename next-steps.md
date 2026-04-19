# Next Steps After the Soundness Review

This note records what is next, what is most urgent, and why. It stays at the
level of architectural priorities rather than prescribing implementation steps,
but each item names code or tests that capture the invariant in question so a
future agent can check the claim without reconstructing the argument.

---

## What is urgent

### 1. Keep semantic facts and profiler-driven speculation visibly separate

The most urgent task is to preserve a boundary that reviewers can inspect
quickly: baseline analysis results must remain semantic, while profiler-driven
narrowing must remain revocable and guarded.

Why this is urgent:
- it is the core soundness boundary of the whole stack;
- once semantic and speculative facts blur together, every consumer becomes
  harder to trust;
- later optimizations are only as sound as this separation is clear.

Checkable by:
- `src/specialization/framework/worklist.ts` — `handleObservationForSpec`
  places narrowed facts in a non-ROOT context, not in the ROOT cell;
- `src/specialization/transforms/*.ts` — every `readExprFact` call omits the
  context argument (defaults to ROOT); any future context argument here
  breaks the boundary and should require explicit justification.

### 2. Make the framework's real support for may/must analysis explicit

The framework should be described in terms that match what it reliably supports
now, especially around must-style reasoning and the four classical quadrants.

Why this is urgent:
- the current architecture is stronger in some quadrants than others;
- over-claiming genericity invites future misuse;
- reviewability improves when the supported contracts are named honestly.

Checkable by:
- `src/specialization/framework/analysis.ts` — `Analysis.polarity` is
  declared per analysis and tested in
  `src/tests/specialization/framework/analysis-polarity.test.ts`;
- `src/specialization/type-requirement-analysis/analysis.ts` is the single
  `polarity:"must"` consumer today; a new must-forward analysis would be the
  first to exercise the meet-merge branch end-to-end.

### 3. Keep unconditional transforms on a non-speculative fact surface

Transforms that rewrite the AST must continue to depend only on unconditional
facts. This boundary is already important and should remain easy to audit.

Why this is urgent:
- unconditional rewrites cannot rely on facts that may later retract;
- this is the main guard against speculative facts leaking into permanent code
  changes;
- a clear boundary reduces future soundness regressions.

Checkable by:
- `src/specialization/framework/transform-rule.ts` — `TransformFactView` is
  the only surface transforms see, and it does not carry a context parameter;
- any transform that starts routing through `specContextFor` or reading a
  non-ROOT cell should be treated as a speculative IR selector, not an AST
  rewrite.

---

## What is important next

### 4. Keep lattice meaning checkable at a glance

The next phase should make it easy to verify that each lattice says what the
analysis thinks it says, especially where representation conventions differ
between domains.

Why this matters:
- lattice coherence is foundational;
- subtle contract drift is hard to detect once more analyses accumulate;
- review should not require reconstructing hidden conventions.

Checkable by:
- `src/tests/harness/lattice-laws.ts` + `lattice-laws.test.ts` enumerate
  `leq ⇔ join=b`, absorption, identity, and idempotence over representative
  slices of `TypeLattice`, `ConstLattice`, `AbsVal`, and the runtime
  observation lattices. Any new lattice should register a slice here.

### 5. Preserve precise speculation retraction

Speculation is most valuable when the system can retract only the assumptions
that actually mattered, rather than collapsing broadly.

Why this matters:
- precision affects both performance and comprehensibility;
- broad widening is safe but expensive;
- guard provenance is part of the architecture's promise, not just an
  optimization detail.

Checkable by:
- `src/specialization/framework/worklist.ts` — `widenGuard` takes a
  lineage-precise path; `widenFullChain` is the coarse fallback. Every
  guard-registration site should supply provenance so `widenGuard` never
  has to fall back silently;
- `src/tests/specialization/runtime/speculative-narrowing.test.ts` covers
  the lineage-recovery path for both node-keyed and fdId-keyed narrowings;
  return-kind uses the `Narrowing.lineageValue` / `lineageEq` hooks in
  `src/specialization/type-requirement-analysis/analysis.ts` to read the
  entry-block requirement fact under each synthetic context.

### 6. Clarify the role of runtime observation and profiling

Runtime signals should remain easy to classify: some are speculative evidence,
some are profitability signals, and they should not read as one undifferentiated
kind of enrichment.

Why this matters:
- different runtime inputs justify different downstream uses;
- reviewers need to know whether a fact changes semantics, enables guarded
  specialization, or merely prioritizes work;
- architecture descriptions should match those distinctions.

Checkable by:
- `src/specialization/framework/runtime-analyses.ts` — each runtime analysis
  declares `polarity: "opaque"`, marking it as neither semantic nor a
  lattice-refining speculative dimension;
- `src/specialization/framework/speculation-strategy.ts` — observation →
  narrowing translation lives in one place; `countBasedStrategy` is the only
  path that turns evidence into an assumption today.

---

## What can wait

### 7. Throughput and scaling work

Performance work remains important, but it should follow the soundness and
contract-clarity questions rather than lead them.

### 8. Additional speculative dimensions

New speculative enrichments can wait until the current semantic/speculative
split and the quadrant story remain stable under review. `returnKindNarrowing`
is the most recent addition (paired with `typeRequirementAnalysis`); the next
dimension should land only after its consumer path is fully exercised.

---

## Guiding themes

As work continues, the architecture should keep the following true:

- semantic facts stay semantic;
- profiler-driven narrowing stays guarded and retractable;
- must and may reasoning are not described as more interchangeable than they
  really are;
- unconditional transforms remain non-speculative;
- lattice and framework contracts remain audit-friendly.

---

## Cold-start reading

For an implementing agent arriving fresh:

- `src/specialization/framework/worklist.ts`
- `src/specialization/framework/fact-store.ts`
- `src/specialization/framework/dfa-factory.ts`
- `src/specialization/framework/interfaces.ts`
- `src/specialization/type-analysis/lattice.ts`
- `src/specialization/type-requirement-analysis/analysis.ts`
- `src/tests/specialization/framework/lattice-laws.test.ts`
- `src/tests/specialization/runtime/speculative-narrowing.test.ts`

That set is enough to verify most claims above before making changes.
