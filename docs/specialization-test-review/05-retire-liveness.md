# 05 — `FunctionRegistry.retire` liveness

## Scope clarification

Two distinct "retire" concepts live in the framework, and conflating them
would moot the question:

- `FunctionRegistry.retire(functionId, ROOT_CONTEXT)` — removes a FunctionDef/
  Lambda/MultiLambda slot from the global registry. **Structural** (AST-level).
- `Worklist.retireChain(unit, node)` — retires an `AssumptionChain` node when a
  speculative runtime observation conflicts. **Speculative** (chain-level).

Only the former is the subject of the comment at `function-registry.test.ts:113`.
`retireChain` has plenty of production callers
(`worklist.ts:1059`, `:1083`) via deopt paths and is not in question.

## Caller census (`FunctionRegistry.retire`)

Production callers: **none.**

Test callers:
- `src/tests/specialization/function-registry.test.ts:65, 77, 153, 176`

That is the complete set under `src/`.

## Caller census (`FunctionRegistry.mint` beyond initial build)

Production callers beyond `buildFunctionRegistry`: **none.**
The only mint sites are `function-registry.ts:171` (the FileInput seed) and
`:178` (the DFS over FunctionDef/Lambda/MultiLambda). No transform, deopt
path, or JIT codegen mints functions post-build. Test callers exercise
`mint` only for re-registration error cases and for the `retire`→`mint`
sequence.

So the mirror-image operation (`mint` for structural transforms) is also
test-only. This is symmetric, not accidental.

## Is the scaffold load-bearing for imminent work?

Evidence from git history:

- Commit `5ef4760e` ("registry: wire mint/retire to structuralPass via
  Worklist listener") explicitly states: *"No production transform mints
  or retires today; the integration test pins the contract as scaffold
  before the first caller arrives."* The comment on the test is a verbatim
  paraphrase of this commit message.
- Commit `921fda9f` ("fix number-keyed retire cell leak") — after the
  scaffold landed, a real leak was found in four passes (`runtimeWritePass`,
  `runtimeCallPass`, `callCountPass`, `purityScopePass`) that relied on the
  blanket unit-keyed evict. The retire-evicts-number-keyed-cells tests in
  question are the regression pins for *that* fix. So the tests are not
  purely prospective — they already caught and now guard a concrete bug.

No TODO/FIXME in the registry or worklist source names an imminent caller.
The class doc (`function-registry.ts:50–62`) in fact argues *against*
shipping a non-ROOT retire caller without first chain-scoping the registry.

Established: the scaffold already earned its keep once (the `921fda9f`
leak). Plausible: future structural transforms (inlining, specialized
clones named in the class doc) will need `retire`, but no such transform
is on the current branch.

## Verdict

**Keep, but rewrite the comment.** Do not delete `retire`.

Rationale:
1. The "no production caller → dead code" framing is factually correct about
   the call graph but misses that the retire *eviction edges* in
   `runtime-passes.ts` / `call-count.ts` / `purity-analysis/analysis.ts`
   (added in `921fda9f`) are exercised exclusively by these tests. Deleting
   `retire` would delete coverage for those eviction edges, which are real
   analysis code that future retire callers will need to be correct.
2. The throws in `retire` are defensive and cheap; the method is ~15 LOC.
   YAGNI pressure is low.
3. The comment, however, is stale: it says "scaffold — no caller" without
   mentioning that the eviction edges it drives are load-bearing. Suggested
   replacement: *"Pins the retire → lifecycle-eviction contract. `retire`
   has no production caller yet (no structural transform mints/retires
   today), but its registered eviction edges in runtimeWritePass,
   runtimeCallPass, callCountPass, and purityScopePass are production code
   — this test is their regression pin (see commit 921fda9f)."*

Risk of shipping `retire` without a caller: low. The method's invariants
(ROOT-only, throw-on-unknown-id, listener dispatch) are all statically
checkable and test-covered. The subtle bugs that would surface under real
eviction pressure live in the *subscribers*, not in `retire` itself — and
the subscribers are already exercised by these tests.
