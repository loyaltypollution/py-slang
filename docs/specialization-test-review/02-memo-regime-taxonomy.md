# Memo Regime Taxonomy — Audit

## Verdict

**No production gap. The A/B/C/D labels are aesthetic.** The real mess is the
duplicated 50-line `runWithJit` harness (test-harness gap, already shared
across every JIT-level test in this directory).

A `worklist.memoRegime(fn)` enum would be a fabrication: production has no
regime state to return, and inventing one would not compose with how the
rewrite actually fires.

## Do A/B/C/D form a coherent taxonomy?

No. Several concrete problems:

1. **The file has five tests, not four.** There are two "C."-labelled tests
   (collatz, and fib-with-`n<0`-guard). The second "C" actually asserts
   `depth === 0` and *no* memo — behaviourally identical to D, not C.
2. **The axes aren't orthogonal.** The comments suggest a 2x2 of
   {pure, impure} x {at-root, under-spec}, but:
   - "A. pure-at-root" and "B. impure-every-chain" are about whether ROOT
     is a purity witness.
   - "C. pure-under-spec" is about whether a non-root chain witnesses purity.
   - "D. spec-broken-by-lit" is about **dispatch stability under retirement**
     (every speculation refuted -> stabilises at ROOT), which is orthogonal
     to purity. The second "C" test is the same phenomenon as D.
3. **The real dimensions exercised are three, not two:**
   (a) is there a purity witness anywhere on the chain,
   (b) does the profitability counter saturate,
   (c) does speculation retire back to ROOT.
   The labels compress (a)+(c) into one axis and mislabel the result.

## What production code each test actually exercises

All five tests drive `memoizationRule.sweep` in
`src/specialization/transforms/memoization.ts`, and their assertions read two
*already-exposed* observables:

- `startsWithMemoHas(body)` — structural check on the AST, matching
  `bodyHasMemoPrelude` inside the rule itself.
- `memoBucketCount(prefix)` via `memoCacheSnapshot()` from
  `src/runtime/memo.ts` — runtime cache occupancy.
- `futureDispatchChainFor(unit).depth` / `.parent` — dispatch stability,
  already a first-class Worklist query.

The rule's gating is:

- profitability: `runtimeCallCounter.at(fd.id) >= MEMOIZATION_THRESHOLD`
- purity witness: `purityScopeAnalysis.readMinimal(chain, fd.id, v => v===true)`
- shape-idempotence: `bodyHasMemoPrelude(witness.forkBody(unit))`

There is **no global "regime"**. The same unit has different outcomes at
different chains because `readMinimal` walks the chain. The witness is
discovered per sweep, not cached as an enum.

## Would `memoRegime(fn)` compose?

No. It would have to return *something per chain*, because the rule's
decision is chain-local (that's the whole point of `readMinimal`). So the
API would be `memoRegime(unit, chain)` returning `{ROOT_MEMO, SPEC_MEMO,
NONE, UNSTABLE}` — and that is just a re-encoding of the existing
`(startsWithMemoHas(fd.body), startsWithMemoHas(specBody), chain.depth)`
triple. It collapses an n-assertion test to a 1-assertion test only by
moving the disjunction into production, where it has no other consumer.

The "D" case (`depth === 0` after every speculation refuted) is further
evidence: that's a property of the dispatch chain, not of memoization.
Folding it into a memo-regime enum conflates two subsystems.

## Real issue

`runWithJit` (lines 19-68) is copy-pasted verbatim across this file and
several sibling JIT tests (`jit-dispatch.test.ts`,
`speculative-clone.test.ts`, e2e suite). Extracting it into
`harness/run-with-jit.ts` would shrink each test to its three observable
assertions and make the "taxonomy" framing unnecessary — the tests would
read as five independent scenarios, which is what they are.

## Referenced files

- `/Users/loremipsum/Code/sourceacademy/py-slang/src/tests/specialization/memoization-purity-regimes.test.ts`
- `/Users/loremipsum/Code/sourceacademy/py-slang/src/specialization/transforms/memoization.ts`
- `/Users/loremipsum/Code/sourceacademy/py-slang/src/runtime/memo.ts`
