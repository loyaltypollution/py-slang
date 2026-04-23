# 06 — "currentShapeFor(fn, argIdx)" query

## Scope

`src/tests/specialization/jit-dispatch.test.ts:42–45`. The comment walks the
reader through `classifyRawValue → paramTypeNarrowing.lift → chain extend →
body selection` to justify why `h(False)` takes the else branch after a hot
int loop. The hypothesis: a missing `worklist.currentShapeFor(fn, argIdx)`
query forces the test to assert via `print` output and the comment to
simulate the pipeline.

## What public queries exist today

Already exposed by the framework (established, not speculative):

- `Worklist.futureDispatchChainFor(unit): AssumptionChain` — the chain a next
  call into `unit` will see. Used by `purity.test.ts:184`,
  `speculative-clone.test.ts:75`, `chain-reconvergence.test.ts:53`.
- `Worklist.futureDispatchChainForNode(nodeId)` — nodeId-keyed variant.
- `AssumptionChain.visibleBody(unit)` — the body that will be served.
- Top-level `findAssumption(chain, narrowing, key)` in
  `framework/assumption-chain.ts:150` — pulls a narrowing value out of a
  chain by its canonical key.
- `paramKey(functionId, slot)` + `paramTypeNarrowing` — the exact key/kind a
  `currentShapeFor(fn, 0)` query would internally resolve.

So the composition `findAssumption(worklist.futureDispatchChainFor(unit),
paramTypeNarrowing, paramKey(fn, 0))` already answers "what is param 0
currently narrowed to". This is the same triple `entry-guards.ts:39` and
`type-analysis/analysis.ts:157` use in production.

## Is the cross-module comment papering over a missing query?

No. The comment explains *why* the runtime correctly reclassifies `False`
as bool rather than int — it's naming the observation → lift → chain-extend
causal chain. Even with a `currentShapeFor` helper, the test would still
need the comment (or equivalent) to explain that `classifyRawValue`
distinguishes bool from int in the first place; that's a fact about
runtime-analysis lifting, not about the Worklist API.

## What the test is actually asserting

"`bool arg after int hot loop takes the correct branch`" is an **end-to-end
dispatch-correctness** test, not a lattice-inspection test. The observable
is: the returned value of `h(False)` is 0. A `currentShapeFor` probe would
assert "after the hot loop the chain carries BOOL for param 0", which is
strictly weaker — it passes even if body selection is broken downstream.
The sibling tests in the same file (`sign-refined speculation`,
`saturated observation channel`) are all structured the same way and for
the same reason: they guard dispatch, not chain state.

## Verdict

**Explanation-is-fine.** `futureDispatchChainFor` + `findAssumption` +
`paramKey` already provide the query; other tests use it when they need it.
This test doesn't, because the invariant under test is end-to-end branch
selection. A `currentShapeFor` convenience wrapper would be a minor
ergonomic shortcut with no production consumer — test-only API surface
that duplicates a one-liner composition. No production gap.
