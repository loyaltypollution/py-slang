# 01 — `hasSpecializedBody` vs. `specBody !== unit.body`

## Test under review

`src/tests/specialization/speculative-clone.test.ts:82-84`:

```ts
expect(
  hasSpecializedBody(unit, specContext, worklist.topology) || specBody !== unit.body,
).toBe(true);
```

Comment: "Either specialization layer may have realized the clone; assert >=1 did."
`specBody` is `specContext.visibleBody(unit)` (line 76).

## What each predicate computes

**`hasSpecializedBody`** (`src/specialization/speculative-clone.ts:88-95`) is
`specializedBodyFor(...) !== undefined`. `specializedBodyFor`
(`speculative-clone.ts:119-153`) returns non-undefined in exactly two cases:

- (a) line 150: `pruned !== source` — the speculative lane's dead-branch
  pruner rewrote `source = context.visibleBody(unit)`.
- (b) line 151: `source !== unit.body` — no new pruning, but a
  context-aware transform (e.g. `memoizationRule` via
  `witnessChain.forkBody(unit)`, `transforms/memoization.ts:161`) already
  published a forked body at an ancestor chain node, so
  `visibleBody` returns that fork.

**`specBody !== unit.body`** is literally case (b) of `specializedBodyFor`:
`visibleBody` walks parents and returns `unit.body` iff no ancestor has an
owned fork (`assumption-chain.ts:64-74`).

## Can they diverge?

Direction 1: `specBody !== unit.body` true, `hasSpecializedBody` false.
Impossible. If `source !== unit.body` then line 151 in `specializedBodyFor`
fires and returns non-undefined, so `hasSpecializedBody` is true. The right
disjunct cannot be true while the left is false.

Direction 2: `hasSpecializedBody` true, `specBody === unit.body`. Possible —
this is exactly case (a): the speculative pruner produced a clone from
`source === unit.body`. The left disjunct catches this; the right does not.

So the right disjunct is **strictly weaker than** the left. It is dead
code — never the deciding vote.

## Verdict: not a gap

The user's framing — "two predicates, contract isn't nameable" — is wrong
here. There is one contract (`specializedBodyFor !== undefined`). The
right disjunct is not a second predicate; it is a redundant partial probe of
one of the two internal branches (case b) of the same predicate.

`hasSpecializedBody` and `specializedBodyFor` are the production contract
(callers: `conductor/PyCseJitEvaluator.ts:75`, `conductor/PySvmlJitEvaluator.ts:62`,
`tests/specialization/harness/jit-runners.ts:53,115`).
Nothing in production compares `visibleBody` against `unit.body` as a
specialization check.

## Why the disjunction exists anyway

Best reading: defensive scaffolding from when the author was unsure whether
the memoization path (case b) would register as "specialized" under
`hasSpecializedBody`. Now that `specializedBodyFor` explicitly returns
`source` at line 151 for case b, the concern is resolved and the right
disjunct is obsolete.

## Suggested cleanup (trivial)

Drop the disjunction and the comment:

```ts
expect(hasSpecializedBody(unit, specContext, worklist.topology)).toBe(true);
```

If the goal is to distinguish "pruner fired here" from "ancestor fork
inherited", assert the two separately — but the current test has already
asserted `specBody !== unit.body` and `specBody.length === 1` on lines 78-79,
which covers the case-(b) shape. The disjunction adds no coverage.
