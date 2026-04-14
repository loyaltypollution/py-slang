# Decisions log — architecture-most-correct worktree

## Phase 0 baseline (test suite at HEAD = e7eec65 "tension point")

```
Test Suites: 3 failed, 32 passed, 35 total
Tests:       2 failed, 2626 passed, 2628 total
```

Pre-existing failures (not caused by this refactor):
- `src/tests/analysis-observe-value.test.ts` — TS2339: `observeWrite` not on `TypeAnalysisPass`/`ConstAnalysisPass` (the "tension point" commit removed the method but left tests).
- `src/tests/worklist-observations.test.ts` — `typeAfter` does not differ from `typeBefore` after `observeWrite`.
- `src/tests/observation-sink-sync.test.ts` — sync-tripwire never throws.

These tests exercise the dissolved-by-design observation pathway. They will be **deleted** in Phase 2/3 when their dissolved primitives are removed, not patched.

Green-checkpoint definition for this run: 32/35 suites passing, 2626 tests passing. Any new commit must keep that floor or improve on it (expected: improve, as dissolved tests get deleted).

## Phase 2 — saturating callCount lattice equals semantics

Spec gave `callCountLattice.equals: (a,b) => a === b`, but `writeInput` gates on `equals` (never `join`), so `equals(50, 51) === false` would store 51 verbatim and break the saturation/early-cutoff guarantee the spec demands in test 3.

Resolved toward stated intent: `equals(a, b) = Math.min(a,50) === Math.min(b,50)`. Two values that both saturate to the same cap are lattice-equal, so writing 51 after 50 is a no-op at the cell layer.

Documented inline in `src/specialization/runtime/inputs.ts`.

## Phase 3 — block-level fixpoint shape (per-unit DFA query, NOT per-block cycle_fn)

The architecture plan describes `blockOut : Block → Env` as a self-recursive
Query iterated via Salsa 3.0 `cycle_fn` over the lattice join. That requires
SCC-aware cycle resolution: when blockOut(A) → blockOut(B) → blockOut(A), the
runtime must iterate the entire SCC, not just the entry cell. Our Phase 1
runtime's `cycle_fn` only handles single-cell self-recursion; cross-cell
same-query cycles fall back to returning the provisional value of the outer
cell, which is incorrect under iteration (B reads stale A value, A's fixpoint
loop re-runs A but B is cached green from the stale read).

**Decision:** model block envs as one fixpoint Query per (unit, analysis):
`typeBlockEnvs : UnitId → ReadonlyMap<BlockId, TypeEnv>` and
`constBlockEnvs : UnitId → ReadonlyMap<BlockId, ConstEnv>`. The query body
runs Kildall iteration internally over the unit's CFG, returns the immutable
per-block env map. `typeOf`/`constOf` are downstream queries that index into
this map and replay transfer to a single node.

Trade-off:
- Lost: per-block cell invalidation (a runtime observation on one block
  re-runs the whole unit's DFA).
- Preserved: early-cutoff at `typeBlockEnvs` (lattice-equal env map across
  recomputes does NOT propagate red to dependents); same coarseness as
  legacy worklist drain, so no regression vs status quo.
- Future work: extend `Db.cycle_fn` to be SCC-aware so per-block cells
  become viable. Not load-bearing for any current use case.

Implementation reuses pure transfer functions from
`type-analysis/analysis.ts` and `const-analysis/analysis.ts`, NOT the
legacy `Pass<K,V>`/`Worklist` machinery. A small standalone Kildall
iterator lives at `src/specialization/runtime/queries/kildall.ts`.

## Phase 5b-i — JitPass replaced by synchronous pull (whole-unit recompile)

Picked option A (whole-unit recompile + patch every function slot) over
option B (AST diff to find the changed FunctionDef). Rationale: matches
`optimizedAstOf`'s unit-granular cache; B adds structural-diff complexity
without a measured win.

Secondary cost: `recompileAndPatch` re-runs `analyzeWithEnvironments` on
the lowered AST because `wrapMemoize` in `pure-rewrites.ts` synthesizes
fresh `FunctionDef` nodes that the original identity-keyed
`functionEnvironments` map does not contain. If JIT compile time
regresses materially on `svml-jit-end-to-end`, either (1) make
`wrapMemoize` mutate body/preserve the outer FunctionDef identity, or
(2) teach the environment resolver to seed synthesized nodes. Flagged
for review; not load-bearing today.

## End-of-run summary (HEAD = e3fb6e1)

| Phase | Status | Commit | Notes |
|---|---|---|---|
| 0 — baseline | done | (uncommitted DECISIONS) | 32/35 baseline failures captured |
| 1 — runtime core | done | d2c2bbf | Input/Query/Db, cycle_fn, early cutoff |
| 2 — driver Inputs | done | e158782 | astOf, runtimeWrite, runtimeCall, environmentsOf |
| 3a — cfgOf | done | 3a03754 | |
| 3b — blockEnvs | done | 755b14c | per-unit DFA shape (deviation, see above) |
| 3c+3d — typeOf, constOf | done | c20e8a6 | per-node projection |
| 3e — scope queries | done | 73bd26b | callCountOf, purityOf, shouldMemoize |
| 4 — lowering chain | done | 57ee225 | structural sharing preserved |
| 5a — svml-compiler reads | done | 8cd2e73 | Worklist still constructed in evaluators |
| 5b — evaluator migration | **deferred** | — | requires JitPass replacement design |
| 6 — dissolve framework | **deferred** | — | requires 5b |
| 7 — introspection | done | e3fb6e1 | depsOf/dependentsOf tested |

**Final test count:** 45/48 suites, 2680/2682 passing. The 3 failing suites
(`analysis-observe-value`, `worklist-observations`, `observation-sink-sync`)
are pre-existing on pr3-fact-store-refactor — they exercise the dissolved
`observeWrite` pathway and will be deleted with the framework in Phase 6.

**Net delta vs branch base (e7eec65):** 37 files, +3184 / -13 LoC.

**Recommended next steps for review:**
1. Read `src/specialization/runtime/db.ts` first — load-bearing; everything
   else is application of the primitives it defines.
2. Then the queries in dependency order: `inputs.ts` → `queries/cfg.ts` →
   `queries/block-envs.ts` (and `kildall.ts`) → `queries/type-of.ts` /
   `queries/const-of.ts` → `queries/scope.ts` → `queries/lowering.ts`.
3. The pure-extraction additions in
   `{type,const}-analysis/analysis.ts` and `purity-analysis/analysis.ts`
   are additive — they should not have changed any pre-existing test.
4. The Phase 5a fallback `db === undefined` in `svml-compiler.ts` is a
   deliberate staging shim; it goes away in 5b.

**Open architectural questions to resolve before 5b:**
- JitPass currently subscribes to `[callCountPass, purityScopePass,
  structuralPass]` and triggers recompile on digest change. The query
  equivalent is a polling tick over `optimizedAstOf(unit)` at safepoints.
  Where are those safepoints in the interpreter dispatch loop?
- Should the Db be per-evaluation (current) or per-conductor-session
  (longer-lived, accumulates observations across multiple chunks)?

## Phase 5 — staged consumer migration (5a: svml-compiler reads only)

Recon found ~27 read sites across 4 files. Full migration in one commit is high-risk:
- `PySvmlJitEvaluator` registers a custom `JitPass` with `reads`/`register`
  for speculative-recompile triggers. Replacing this requires a polling tick
  on `optimizedAstOf` and a recompile orchestration layer not yet designed.
- The three evaluators construct `new Worklist(...)` and call `worklist.converge()`.
  Removing this stops driving the legacy fact store, breaking any consumer not
  yet migrated (including the JitPass above).

**Phase 5a (this commit):** migrate `svml-compiler.ts` only. Replace
`factStore.tryRead(typeAnalysisPass|constAnalysisPass, nodeId)` with
`typeOf.get(db, nodeId)` / `constOf.get(db, nodeId)`. Compiler accepts a
`Db` parameter alongside the legacy `factStore`; for now both are
plumbed through, compiler reads the Db. All three evaluators still
construct the Worklist and pass `factStore` for consumers that still
need it (none after this change, but verify test suite).

**Phase 5b (deferred to morning review):** evaluator-level migration —
remove Worklist/factStore construction once nothing reads it. Requires
JitPass replacement, which is non-trivial.

This staging keeps Phase 5a's commit reversible if test failures
appear; Phase 5b is the real architectural cut.

## Phase 2 — Db lifecycle

`Db` lives as `protected db: Db` on `PyCseEvaluatorBase`, re-instantiated per `evaluateChunk`. No module-level singleton. Phase 3+ queries reach it via the evaluator class.

## Phase 6 — framework dissolution (collapsed)

Sub-phases 6-i…6-iv merged into a single commit. The plan's incremental
boundaries don't survive a hidden coupling it missed: the pure helpers
`transferBlockPureType` / `transferBlockPureConst` (the very entry points
the runtime queries call) internally allocated a throwaway `FactStore` and
used `runtimeWritePass` as an opaque key to seed observations. Deleting
`FactStore` / the `Pass` token cannot happen *after* deleting `dfa-factory`
without first removing this coupling — and once removed, every other
deletion follows mechanically with no test-bisectable midpoint.

### What got refactored

`framework/block-transfer.ts` lost the `AnalysisPass<L>` parameter and
gained a `BlockTransferSpec<L> = { top, direction, makeVisitor }`
descriptor. The two analysis modules now expose
`transferBlockWithObservations(block, inEnv, slotLookup, observations)`
plus the `nodeXFactsForBlock` projector — both take a
`ReadonlyMap<NodeId, unknown>` directly. No `FactStore`, no Pass tokens,
no AnalysisPass interface implementation. The visitor classes consult
`observations.get(node.id)` instead of `factStore.tryRead(runtimeWritePass, node.id)`.

`block-envs.ts` (the only caller of the per-pure helpers) was renamed to
match. All other call paths to the legacy framework went away with the
deleted files.

`function-unit.ts` lost the `analyses` parameter and the per-analysis
`analysisOuts: Map[]` field — `FunctionUnit` is now a pure structural
record (`funcAst`, `slotLookup`, `body`, `cfg`, `blockMap`, `blockOfNode`).

### Files deleted

```
src/specialization/framework/migrated-passes.ts
src/specialization/framework/runtime-passes.ts
src/specialization/framework/dfa-factory.ts
src/specialization/framework/dfa-passes.ts
src/specialization/framework/pass.ts
src/specialization/framework/fact-store.ts
src/specialization/framework/worklist.ts
src/specialization/framework/interfaces.ts
src/specialization/framework/structural-pass.ts
src/specialization/framework/view.ts
src/specialization/framework/block-of-node.ts
src/specialization/transforms/dead-branch.ts
src/specialization/transforms/constant-folding.ts
src/specialization/transforms/memoization.ts
scripts/dump-ast.ts                                     (already broken; HintStore deleted long ago)
```

`structural-pass`, `view`, and `block-of-node` were not in the plan's
explicit delete list but had no remaining consumers after the others were
gone. Kept (pure helpers): `cfg.ts`, `mutable-env.ts`, `slot-table.ts`,
`block-transfer.ts`, `function-unit.ts`.

`TypeAnalysisPass` / `ConstAnalysisPass` *class* exports also went away
— their only consumers were tests using `buildTestWorklist`, and the new
`transferBlockWithObservations` factory function makes the visitor lifecycle
internal.

### Test decisions

| Test                                  | Decision         | Rationale                                                      |
|---------------------------------------|------------------|----------------------------------------------------------------|
| `fact-store.test.ts`                  | deleted          | exercises a deleted primitive in isolation                     |
| `pass-graph-dispatch.test.ts`         | deleted          | exercises Worklist dispatch graph (deleted)                    |
| `convergence-benchmark.test.ts`       | deleted          | benchmarks Worklist `WorklistStats` (deleted)                  |
| `observe-loop.test.ts`                | deleted          | observe→type widening covered by `runtime/type-of.test.ts`     |
| `reactive-optimization.test.ts`       | deleted          | folding/dead-branch behavior covered by `runtime/lowering`     |
| `cse-hint-visualization.test.ts`      | deleted          | visualization pathway dead; FactStore-coupled                  |
| `memoization.test.ts`                 | deleted          | wrap behavior covered via `runtime/lowering` + `memo-lookup`   |
| `jit-recompile-trigger.test.ts`       | deleted          | saturation in `runtime/scope-queries`; recompile in `svml-jit` |
| `purity-analysis.test.ts`             | deleted          | now covered by `runtime/scope-queries.test.ts purityOf`        |
| `svml-jit-end-to-end.test.ts`         | rewritten        | first test (patchFunction wiring) preserved against new arch   |
| `svml-observation.test.ts`            | rewritten        | now exercises `runtimeWrite.set` → `db.get(typeOf, …)`         |
| `review-findings.test.ts`             | rewritten        | hint readers retargeted to `db.get(typeOf, …)`                 |
| `interpreter-replace-program.test.ts` | mech. update     | `buildTestWorklist().converge()` → `buildTestUnits()`          |
| `specialization-opcodes.test.ts`      | mech. update     | additionally rewired through `optimizedAstOf` for fold tests   |
| `specialized-opcodes.test.ts`         | mech. update     | same swap                                                      |
| `svml-stable-indices.test.ts`         | mech. update     | same swap                                                      |
| `memoization-svml.test.ts`            | mech. update     | same swap                                                      |

`buildTestWorklist` was deleted from `tests/utils.ts` and replaced by
`buildTestUnits(ast, environments) → { db, units }`, the minimum surface
the new SVMLCompiler integration tests need.

### Result

`yarn test`: 36/36 suites, 2572 tests passing. Down from 45/45 (×2628 tests)
in the last green Phase 5b commit; the 9 deleted suites were either
exercising deleted primitives directly or were redundant with the 13-suite
`runtime/` test directory that pins the new architecture.

## Phase 8 — SCC-aware cycle_fn spike, deferred

**Outcome:** spike attempted, both passes (engine + per-block port) reverted.
Final state: db.ts and block-envs.ts unchanged from pre-spike HEAD. 36/36
suites green.

### What was attempted

**Pass 1 — SCC engine in `Db`.** Extended `Db.recompute` so that when a cell
of an `isCyclic` query is re-entered while an ancestor cell of the SAME
query is still computing, the new cell is marked a non-leader participant
and registered with the outermost-on-stack cyclic same-query frame (the
"leader"). Leader's outer loop runs `query.fn` once per iteration, then
re-runs each registered participant via a stored single-iteration callback
that pushes the participant's frame and re-invokes `query.fn`. Loop
terminates when neither leader nor any participant value changes across a
full pass; throws at 200-iter cap.

The engine itself worked. Four new tests passed: cross-cell two-cell SCC,
three-cell SCC, divergent SCC throws, non-participant green observer. 7/7
cycle.test.ts cases green.

**Pass 2 — Per-block `typeBlockOut`/`constBlockOut`.** Defined per-block
queries keyed by `{unitId, blockId}`, each `isCyclic`. Body: read CFG,
compute IN env from preds via `db.get(typeBlockOut, pred)` (which records
deps and drives the SCC for back-edges), run block transfer, return OUT.
`typeBlockEnvs`/`constBlockEnvs` became thin wrappers iterating `db.get`
per block.

### Where it got stuck

`yarn test` after pass 2: 35/36 suites — `specialization-opcodes.test.ts`
went 11/18 → all 11 loop tests failed. Root cause traced via instrumented
trace on a `while`-loop program:

The SCC algorithm, as specified, runs participants in **registration
order** (essentially DFS post-order from the leader). For a forward DFA
where `transfer(bottom_env)` can produce TOP (because the pure transfer
visitor has no information and pessimistically widens), the first pass
through the SCC computes:

- Loop-body block B3 runs first (registered innermost). Reads loop-header
  B2, which is in `'computing'` state → returns provisional value
  `bottom` (empty env). Transfer of `s = s + i` over an empty env infers
  TOP for s. B3.OUT = `[TOP, TOP]`.
- B2 then joins entry-block-OUT (`[INT, INT]`) with B3.OUT (`[TOP, TOP]`)
  → `[TOP, TOP]`.
- All subsequent iterations re-run with TOP → stable at TOP.

The standard Kildall worklist (which the per-unit `kildall.ts` implements)
avoids this by initializing every block's OUT to `bottom` AND processing
blocks in a deterministic order such that B2 sees B3=bottom (correctly
absorbed by join's identity) BEFORE B3 ever runs against a B2 holding TOP.
The resulting iteration converges to `[INT, INT]` for both blocks.

In other words: the SCC runtime, as implemented, gives a sound but
maximally-imprecise fixpoint; standard Kildall gives the precise least
fixpoint. This is not a bug in the SCC engine — it's a structural
mismatch between "DFS-driven recursive evaluation with provisional
bottom" and "BFS/RPO-driven worklist with proper initialization for
forward DFA." The transfer is monotone but its behavior on empty envs is
discontinuous (gap from `bottom_env` to `top_lattice`).

### What a next attempt would need

Two viable paths:

1. **Pre-initialize all blocks before SCC runs.** Before the leader
   invokes its body, do a quick CFG walk that pre-creates `typeBlockOut`
   cells for every block in the unit with `cell.value = bottom_env` and
   `cell.state = 'green'`. Then the leader's body sees green-but-bottom
   preds (correct join identity) instead of provisional-from-stack
   bottom. This is essentially smuggling Kildall's initialization into
   the runtime.

2. **Reverse-postorder (or chaotic-iteration) participant ordering inside
   the leader's loop.** Instead of registration order, store participants
   keyed by CFG dominator/RPO position. Participant order would have to
   be computed lazily as new participants appear (the leader doesn't
   know the CFG in advance — it just runs `fn`). Less general than (1)
   and pollutes the runtime with CFG-aware logic.

Path (1) is cleanest but commits the runtime to an "SCC pre-warm" hook
that pure cyclic queries (e.g. the saturating-cap test cases) don't
need. A separate RFC should weigh whether per-block invalidation is
worth that complexity.

### Honest assessment

Per-unit `typeBlockEnvs`/`constBlockEnvs` (running internal Kildall over
the CFG) remains the correct shipped architecture. The lost capability
— per-block cell invalidation when a single observation lands inside one
block — is the same coarseness as the legacy worklist drain, so this is
not a regression vs status quo. The SCC engine is implementable and
testable in isolation (see the deleted four tests for the spec); the
hard part is integrating it with Kildall-grade DFA precision. That
integration deserves a deliberate design pass, not a time-boxed spike.

---

## Round 2 Phase A — independent audit (HEAD = e2f1e26)

Second overnight agent run. Audited round 1's self-report without trusting it.

### Verified

- **Test state: 36 suites / 2572 tests passing.** Exact match to round 1's claim. `yarn test` clean, 16s wall time.
- **Deleted files.** All 15 paths in §"Files deleted" are absent from the tree. Three additional files were also deleted and correctly disclosed (`structural-pass.ts`, `view.ts`, `block-of-node.ts`).
- **Query purity.** All 12 named queries (`typeOf`, `constOf`, `optimizedAstOf`, `astAfterDeadBranch`, `astAfterConstFold`, `astAfterMemoize`, `callCountOf`, `purityOf`, `shouldMemoize`, `cfgOf`, `typeBlockEnvs`, `constBlockEnvs`) exist under `src/specialization/runtime/queries/`, read only via `db.get`, and contain zero `.set(db, …)` calls inside their bodies. Grep confirmed.
- **No resurrected primitives.** Zero live-code references to `FactStore`, `class Worklist`, `AnalysisPass<`, `affectedKeys`, `coarse: true`, `runtimeWritePass`. Surviving mentions are all in comments.

### Findings to address

1. **DECISIONS §end-of-run is stale.** The note "The Phase 5a fallback `db === undefined` in `svml-compiler.ts` is a deliberate staging shim; it goes away in 5b" refers to a shim that Phase 5b already removed (`e0f22a6 — drop factStore from SVMLCompiler`). The claim in the phase table that 5b/6 are done is correct; the §end-of-run note was written at Phase 5a time and never retracted. Doc-rot, not code-rot. Will clean as part of round 2.

2. **Stale `runtimeWritePass` comments in interpreters.** `src/engines/svml/svml-interpreter.ts:93,798` and `src/engines/cse/interpreter.ts:844` reference a symbol that no longer exists. The code underneath correctly calls the new `observeNodeWrite` hook. Comments are misleading; will fix.

3. **`optimizedAstOf` is an unnecessary pass-through.** `queries/lowering.ts` defines it as `defineQuery(..., (db, unit) => db.get(astAfterMemoize, unit))`. Creates an extra cell + dep edge for no semantic gain — `optimizedAstOf` could be `astAfterMemoize` itself (re-export or alias). Minor complexity; worth a cleanup commit during round 2 review pass.

4. **`purityOf` scope walk is O(n) AST scan, uncached per cell.** `queries/scope.ts:73-96` re-walks the entire `FileInput` on every `purityOf(scopeId)` invocation to locate the matching `FunctionDef`. Correctness is fine; performance debt the plan didn't flag. On a program with N top-level functions, `purityOf` × N = O(N²) walks on a cold Db. A `functionDefByScope: Unit → Map<ScopeId, FunctionDef>` query would flatten this. Not blocking; noting for a future perf pass.

5. **Partial coverage gaps vs. deleted suites.**
   - `reactive-optimization.test.ts` tested while-loop const propagation convergence through the Worklist. `runtime/lowering.test.ts` tests the rewrite output (`x = 2 + 3` → literal 5, dead branch removal) but the while-loop DFA-fixpoint-under-const-propagation case isn't exercised end-to-end in the replacement suite. `runtime/const-of.test.ts` tests `constOf` individual projection; `runtime/block-envs.test.ts` tests Kildall convergence separately; the *composition* (const propagation through a back-edge-stable loop, surfacing in a fold) is not covered.
   - `purity-analysis.test.ts` likely covered nested functions and lambdas; `runtime/scope-queries.test.ts` has only two purity cases (pure literal, impure `global`). No nested-function or lambda coverage.
   - Not regressions (the underlying machinery is tested in isolation), but round 1's claim of full replacement is optimistic. Round 2 may add the missing composition tests if time permits after Phase D.

### Not found

- No live shim, no sanctioned-only fallback, no `// TODO: remove later` that masks an incomplete migration. The migration is actually complete at the symbol level.

### Action items for round 2

- Phase A-fix (this commit): remove stale comments in interpreters, fix `§end-of-run` note, collapse `optimizedAstOf` to a re-export (or leave with a brief note justifying the extra cell). Add coverage for while-loop const propagation and nested-function purity only if Phase D leaves time.
- Proceed to Phase B.

---

## Round 2 Phase B — recompileAndPatch env resolver coupling resolved

`recompileAndPatch` no longer runs `analyzeWithEnvironments` on the lowered
AST. The fix threads a `LoweredUnit = { ast, environments }` pair through the
three pure rewriters and their corresponding lowering queries instead of AST
alone.

### Why this shape

Option 1 considered in round 1 ("mutate the outer FunctionDef in place") was
rejected — it violates query purity (`astAfterMemoize` would mutate its
`astAfterConstFold` input). Option 2 ("teach env resolver to synthesize
entries for new nodes") is what this change implements, but pushed the
synthesis *into the rewriters* rather than a post-hoc walk. The rewriters
already know exactly which nodes they replaced; harvesting that mapping
there is O(replacements) with zero extra tree traversal, vs. O(tree) for a
two-AST diff.

Only memoize actually replaces `FunctionDef` nodes; dead-branch and
const-fold only rebuild the outer `FileInput`, so they carry just the
root-scope entry. `FunctionEnvironments` is keyed solely on
`FileInput | FunctionDef | Lambda | MultiLambda` (see
`src/resolver/resolver.ts:15-18`), so synthesized statements inside
memoize prelude are not scope-introducers and don't need env entries.

### Shape changes

- `LoweredUnit` interface exported from `pure-rewrites.ts`.
- `rewriteDeadBranch`, `rewriteConstantFold`, `rewriteMemoize` now take and
  return `LoweredUnit`. Each returns the input reference unchanged when
  nothing changed (preserves early cutoff).
- New queries: `loweredAfterDeadBranch`, `loweredAfterConstFold`,
  `loweredAfterMemoize`, `optimizedLoweredOf` (alias of
  `loweredAfterMemoize`), `optimizedEnvironmentsOf`.
- Legacy `astAfterDeadBranch` / `astAfterConstFold` / `astAfterMemoize` /
  `optimizedAstOf` retained as thin `.ast` projections — no AST-only
  caller needed to change. Tests + SVML compiler consumers untouched.
- `PySvmlJitEvaluator` reads `optimizedLoweredOf` (not `optimizedAstOf`)
  so it gets both AST and environments in one cell lookup; the
  `analyzeWithEnvironments(ast, "", 4)` call in `recompileAndPatch` is
  gone.

### Verification

`yarn test`: 36/36 suites, 2572 tests passing. `svml-jit-end-to-end`
specifically exercises recompile-on-saturation; still green without the
resolver re-run.

### Secondary cost removed

DECISIONS §Phase 5b-i "secondary cost" note (resolver re-runs synthesized
nodes) is now closed. If compile-latency micro-benchmarks are added later,
they should show the call-50 recompile drop by the cost of one full
resolver pass per wrapped unit.

### Follow-up (not blocking)

- The `astExtractor` projection queries allocate their own cell per stage
  (name = `astAfterX`) even though they're pure pass-throughs. Acceptable
  for readability — introspection sees the stage name — but these could be
  direct property accessors if cell pressure ever matters.
- `optimizedEnvironmentsOf` is similarly a thin projection. Kept for
  symmetry with `optimizedAstOf`; consumers needing both fields should
  read `optimizedLoweredOf` directly (one cell hit instead of two).

---

## Round 2 Phase C — Db lifecycle + safepoint polling

Closed without code changes. Both sub-questions resolve to "current shape
is correct; document why."

### (c) Db lifecycle: stays per-evaluateChunk

Surveyed all evaluators under `src/conductor/`:
- `PySvmlEvaluator`, `PySvmlJitEvaluator`, `PySvmlSinterEvaluator`,
  `PyCseEvaluator`, `PyWasmEvaluator` each implement `evaluateChunk`
  by parsing + resolving + compiling + running a *fresh* program end to
  end. There is no persistent interpreter or heap state carried across
  `evaluateChunk` invocations — chunks are independent programs.
- No test in `src/tests/` drives two chunks through a single evaluator
  instance; the conductor's `BasicEvaluator` base class does not share
  execution state across calls.

Implication: making the Db per-session would not unlock any cross-chunk
memoize behavior, because the function `fib` defined in chunk 1 is
unreachable from chunk 2 — there is no running interpreter to patch, no
shared function table, no shared call-count namespace. The Db is just
analysis scaffolding; its lifetime matches the program whose analysis
facts it holds.

Staying per-chunk keeps scope isolated, avoids a Db-retention leak on
long-lived conductor sessions (each Db holds the full analysis cell
store), and matches how the other evaluators treat their per-chunk
state. Per-session Db is a design knob that stops being YAGNI the day
the conductor grows a persistent-interpreter evaluator (e.g. a true
REPL VM with sticky function table across chunks). No such evaluator
exists today, and the test suite does not exercise that shape.

### (b) Safepoint polling: already at the right site

The JIT evaluator's pull already happens at `observeScopeCall` — one
check per dynamic function invocation, not per bytecode instruction.
That's the right coarseness:
- Per-instruction polling would defeat the O(1)-per-call early-cutoff
  guarantee, because even a lattice-equal `db.get(optimizedLoweredOf)`
  does a cache-hit + dep-edge walk at every step.
- Per-CALL polling is naturally rate-limited by program structure —
  once a hot function is memoized, its new wrapped body short-circuits
  further CALLs, so the polling rate drops on its own.

CALL-site polling also lands recompiled dispatch *one call earlier*
than RETURN-site polling: the Nth call itself runs through the freshly
patched slot, instead of the Nth call using the old IR and the (N+1)th
seeing the patch. The cost is identical (one pull per call either
way), so CALL is strictly better.

Not documented in code before this run. Adding a one-line note at the
pull site to cement the rationale.

### Verification

No code changes. Existing tests stay green. `runtime/lowering.test.ts`
"early cutoff" case pins the O(1)-past-saturation behavior at the
query layer; `svml-jit-end-to-end.test.ts` pins `patchFunction` wiring.
End-to-end "memoize installs at call 50 through `PySvmlJitEvaluator`"
is *not* directly asserted — it's covered compositionally by the two
gates above plus Phase B's env-threading fix. Adding a BasicEvaluator
integration harness for this is deferred as overengineering for the
current test surface.

### Follow-up (not blocking)

- If a persistent-interpreter evaluator is introduced, revisit Db
  lifetime and the observeScopeCall pull — per-session Db may become
  correct, and a cross-chunk call-count namespace would need design.

---

## Round 2 Phase D — Phase 8 deferred again (this time with a design spec)

Budget said "two implementation attempts; if both fail, document and
move on." On rereading round 1's spike notes I concluded path (1) alone
is not implementable — the specification is incomplete. Rather than
burn an attempt on an under-specified design, this section sets out
what the actual design has to resolve *before* code is written.

### Why path (1) alone does not suffice

DECISIONS §Phase 8 describes path (1) as: "Before the leader invokes
its body, do a quick CFG walk that pre-creates `typeBlockOut` cells
for every block in the unit with `cell.value = bottom_env` and
`cell.state = 'green'`."

This fixes exactly one failure mode from the spike: when block B3 runs
first and reads B2 (in state `'computing'`), the pass-1 SCC engine
returned B2's *provisional* value from the stack frame — which was
bottom — and the pure transfer over empty env inferred TOP. Pre-warm
replaces that provisional read with a *cached green* bottom, so the
join identity works and B2's transfer absorbs to INT.

But consider what happens next:
- B3 runs, reads B2 (green, bottom) → OK, transfers correctly.
- B3's value is now non-bottom.
- B3 returns. The runtime sees B3's value changed and... what? B2 was
  prewarmed with no deps, so B2 is green-but-bottom with no
  dependency on B3. Nothing triggers B2 to recompute. The fixpoint
  never iterates.

Pre-warm fixes the *initial condition* but doesn't drive *iteration*.
Driving iteration across cells requires the pass-1 SCC engine: when a
cyclic query's cell re-enters same-query frames that are already on
the stack, register participants under the outermost-leader, and have
the leader's outer loop re-run participants to fixpoint.

So path (1) is necessary but not sufficient. The real shape is
**SCC engine + pre-warm**, both, together:

1. SCC engine from pass-1 of the spike: leader tracks registered
   participants, iterates until no value changes.
2. Pre-warm from path (1): before leader's first iteration, the
   leader's body (or a runtime hook it opts into) walks the unit's
   CFG and seeds all sibling block cells to bottom-green with no deps.
3. During iteration: leader runs its transfer once. When it reads a
   predecessor that was prewarmed, it sees bottom (correct). When the
   transfer produces a new value, the runtime must invalidate the
   prewarmed-but-unread siblings transitively, since they're part of
   the same SCC.

(3) is the step neither the spike nor path (1) explicitly specified.
Without it, the SCC is inert after pre-warm. With it, the SCC engine
has to distinguish "prewarmed-for-SCC" cells (invalidate within the
SCC's iteration scope) from "prewarmed-for-isolation" cells (never
invalidate — e.g. a cyclic but not-CFG-driven query). That
distinction doesn't exist in today's runtime.

### What the design needs to specify

Before code is written again, the following must be pinned down:

1. **Prewarm scope.** Who owns the prewarm list? The caller of the
   cyclic query (analysis-side knowledge of CFG), or the runtime (via
   a query-declaration hook like `prewarmArgs: (args) => Args[]`)?
   Analysis-side is cleaner; runtime-side is more symmetric with the
   existing `isCyclic` declaration.

2. **SCC participation and scope.** How does the runtime know two
   cells of the same cyclic query are in the same SCC? Pass-1's
   stack-frame registration worked for cells that actually re-enter
   each other through cross-cell reads, but prewarmed cells are read
   without re-entering. Options:
   - Leader explicitly declares its participants at prewarm time
     (ties analysis to runtime semantics).
   - Runtime treats every prewarmed same-query cell as a participant
     of the leader's SCC (coarse; may over-iterate on lattices where
     unrelated cells coexist — rare for CFG-driven analyses).
   - Runtime scopes participation per `get` call chain (most precise,
     most complex).

3. **Fixpoint termination.** Pass-1's termination ran a full pass
   across all participants without change. With prewarm, does
   "across all participants" include prewarmed-but-never-read cells?
   If yes, every pass re-reads every block (expensive). If no, dead
   blocks in the CFG never iterate (fine — they'd never contribute
   anyway).

4. **Dependency recording.** Currently `db.get` records a dep on the
   caller's stack top. Pre-warmed cells that are never read from
   iteration record no edges. That's correct for dead blocks, but
   for blocks reachable only through the back-edge, the cell never
   gets read, hence never gets a dep on its predecessors — its
   invalidation semantics are wrong if `runtimeWrite` later lands
   on a node inside it.

5. **Invalidation granularity.** The whole point of per-block cells
   was: a `runtimeWrite` on one node invalidates one block's cell,
   not the whole unit's Kildall. But SCC semantics say: any
   participant's value change iterates the whole SCC. So
   invalidating one block-cell of a cyclic SCC re-iterates *the
   whole SCC*. Net gain over per-unit Kildall: only dead-code
   blocks and acyclic tail blocks are spared. In a loop-heavy
   program, this is nearly zero improvement.

### Revised recommendation

Per-block cyclic queries are architecturally pure but **operationally
no faster than the shipped per-unit `typeBlockEnvs`** for loop-heavy
code, because SCC iteration still drains the whole loop on any
observation landing inside it. The win is only on straight-line code
and pre-loop blocks — a narrow set.

Shipping this is worth ~weeks of runtime work (SCC engine + prewarm
hook + invalidation-scope rules + test coverage across all five
questions above) for a narrow precision win. The shipped per-unit
query already matches the legacy worklist drain coarseness.

**Deferred again, with a concrete trigger.** Revisit when either:
- A profiler shows per-unit Kildall re-runs dominate hot-path cost
  (measurable; likely not the case for programs small enough to run
  in-browser).
- A new analysis lands whose lattice needs per-block granularity for
  correctness, not performance (e.g. a path-sensitive analysis where
  the per-unit join would over-widen).

Until then, per-unit `typeBlockEnvs`/`constBlockEnvs` is the
architecturally-stable choice, not a compromise.

### Verification

No code changes this phase. `yarn test`: still 36/36 / 2572.

---

## Round 3 — path selection for Phase 8

User requested Phase 8 implementation. Worked the five open design
questions to pin whether path X (SCC engine + prewarm) or path Y
(semi-naive Datalog prototype) is an overnight-scale fit.

### Questions, provisional answers

1. **Prewarm scope ownership.** Caller-side. Analysis knows its CFG;
   runtime shouldn't learn CFG shape. The leader-block's query body
   walks the CFG once and registers siblings.

2. **SCC participation.** Explicit: the leader's body, while
   prewarming, also declares the participant set to the runtime. Ties
   analysis to runtime but pays for precision over coarser
   "any-same-query-cell-is-a-participant" rule.

3. **Termination.** Track dirty participants (those whose value
   changed since last iteration); terminate when dirty-set is empty.
   Unread cells stay at bottom-green and never enter the dirty set —
   correct by construction.

4. **Dep recording for never-read blocks.** *Unresolved.* Prewarm
   creates green cells with no deps. If a later `runtimeWrite` lands
   on a node inside such a block, the cell must still invalidate —
   but the reverse-index has no edge to it. Two fixes on the table,
   both with costs:
   - (a) Eagerly read all participants during the leader's first
     iteration to force dep registration. Costs an extra full CFG
     walk worth of reads.
   - (b) Introduce a new runtime primitive — "prewarm with declared
     deps" — where the prewarm call registers the block's inputs
     (runtimeWrite on its nodes, etc.) as deps without executing the
     body. This grows the runtime API.
   Neither is small. Picking requires a design decision I'd rather
   make in daylight.

5. **Invalidation granularity.** *Partially resolved.* For blocks
   inside an SCC, invalidation still drains the whole SCC's
   iteration — same coarseness as per-unit Kildall for the loop
   body. For blocks outside the SCC (entry prologue, post-loop
   epilogue, acyclic tails), per-block invalidation is a genuine
   win. Typical py-slang function: 50–70% of blocks are
   acyclic-after-the-loop, so the win is real but not dramatic.

### The spike's structural trap is still there

Pass-1 of the previous spike (DECISIONS §Phase 8) built an SCC
engine that processed participants in DFS registration order; a
forward DFA's transfer over `bottom_env` pessimistically widens to
TOP, so the first participant pass produced all-TOP values that then
propagated. Pre-warm fixes this for the *first* iteration's reads
(green-bottom instead of provisional-from-stack), but the SCC engine
itself was reverted — reintroducing it is part of path X's scope, not
a standalone prerequisite.

### Honest scope accounting

Path X requires, at minimum:
- Re-introduce the reverted SCC engine from the prior spike (~150 LoC
  in `db.ts`).
- Add a `prewarm` primitive with dep-registration semantics per
  question 4 (another ~50 LoC in `db.ts`, or a protocol change).
- Migrate `typeBlockEnvs`/`constBlockEnvs` to per-block queries with
  a leader-block responsible for prewarm + participation declaration
  (~200 LoC across analysis modules).
- New tests: verify per-block invalidation independence on a
  loop-heavy program, verify the SCC engine doesn't hit the
  provisional-bottom trap.

Path Y requires, at minimum:
- A JS-native semi-naive Datalog evaluator over a lattice semiring
  (~300–500 LoC in a new `runtime/datalog/` directory).
- Rule-set encoding of the type + const analyses (~100 LoC).
- Query wrapper so `typeBlockEnvs` delegates to the evaluator.
- Same test coverage as path X.

Either is multi-session work. Path Y has cleaner termination and
sidesteps question 4 entirely (Datalog rules natively have deps on
their atoms via the rule body; no "prewarm with deps" protocol
needed). Path X has smaller diff but more subtle correctness
surfaces.

### This session's decision

Do **neither path in this session.** Writing a half-implementation
of Phase 8 with a known correctness trap (question 4 unresolved) is
worse than leaving it deferred. Instead, use the remaining time for
a genuinely complete end-to-end trace through `PySvmlJitEvaluator`
itself — the python-trace test added this session exercises each
query layer in isolation but does *not* run the interpreter and
observe memoize installation in anger. Closing that gap is concrete
value, independent of Phase 8.

Phase 8 recommendation for the next session (or an in-daylight
design sprint): **pick path Y**. The question-4 resolution comes for
free from Datalog's dep-on-body-atoms semantics, and the Phase 8
failure mode does not exist in a semi-naive evaluator because IDB
facts are initialized to bottom and iterated stratum-by-stratum —
structurally identical to Kildall's worklist. This matches the
RETROSPECTIVE.md finding on substrate fit.






---

## Round 4 Phase 9-A — evaluator surface + integration shim (architecture note)

Two `feature-dev:code-architect` subagents ran in parallel — one on the
evaluator's TypeScript surface, one on how it plugs behind the existing
`typeBlockEnvs`/`constBlockEnvs` Salsa cells. Both converged on the same
shape. Synthesis below.

### Honest framing up front

Under the plan's stated non-goals (monotone join only, single lattice,
TypeScript closure transfer, no rule DSL, no negation), the "semi-naive
Datalog evaluator" is **algorithmically identical to the existing Kildall
worklist**. Bottom-init everywhere, leq-gated re-enqueue on predecessor
change, same iteration cap. Calling the replacement "Datalog" is
marketing at the level of the scoped non-goals — there are no rules, no
atoms, no aggregation other than the per-slot lattice join the env map
already does.

What the Round 3 / round-4 path Y refactor actually buys, on this scope:

1. **Module boundary.** A dedicated `src/specialization/runtime/datalog/`
   home for the iteration engine, separate from the `kildall.ts` helper.
   Makes future extensions (e.g. multi-lattice cross-analysis, true
   delete-rederive incrementality) have an obvious landing zone.
2. **`changedBlocks` return value.** The evaluator surfaces its
   termination dirty-set to the caller. Today's `kildall` discards it.
   This is the concrete enabler for 9-E (per-block invalidation
   downstream) — without it, the Query cell can't know which blocks
   actually moved.
3. **Naming + comments that match published literature.** IncA / DRedL
   precedent is real; the shape we land on is recognisably semi-naive
   even if on this scope it collapses to Kildall. Future maintainers
   reading the plan + DECISIONS can join the thread faster.

Not buying, on this scope: different iteration complexity, different
precision, different dep-tracking. 9-C/9-D are largely a rename + module
move + wiring the `changedBlocks` pipe.

### Chosen evaluator surface

Single public function. Stateless. Returns `{ envs, changedBlocks }`
where `envs` matches today's `kildall` return type exactly.

```ts
// src/specialization/runtime/datalog/semi-naive.ts

import type { BasicBlock, BlockId, CFG } from "../../framework/cfg";
import type { MutableEnv } from "../../framework/mutable-env";
import type { Lattice } from "../lattice";

export type BlockTransfer<L> = (
  env: MutableEnv<L>,
  block: BasicBlock,
) => MutableEnv<L>;

export interface SemiNaiveResult<L> {
  readonly envs: ReadonlyMap<BlockId, MutableEnv<L>>;
  readonly changedBlocks: ReadonlySet<BlockId>;
}

export function semiNaive<L>(
  cfg: CFG,
  lattice: Lattice<MutableEnv<L>>,
  initial: MutableEnv<L>,
  transferBlock: BlockTransfer<L>,
  opts?: { iterationCap?: number },
): SemiNaiveResult<L>;
```

Notes:
- Keeps `kildall`'s existing "transfer is a closure; caller pre-binds
  slotLookup + observations" contract. No parameter lifting. The tests
  in `runtime/block-envs.test.ts` + all `transferBlockWithObservations`
  call sites stay identical.
- `changedBlocks` accumulates across the whole fixpoint loop, not just
  the final pass. It's the set of every block whose OUT strictly
  increased at least once during this run. Empty iff the call was a
  no-op from the given initial state.

### Eval loop (pseudocode; mirrors `kildall.ts` with minor differences)

```
function semiNaive(cfg, lattice, initial, transferBlock, opts):
  outEnv = Map<BlockId, Env>
  for block in cfg.blocks: outEnv[block.id] = lattice.bottom
  // entry IN is `initial`; entry OUT still starts at bottom and is
  // computed by the first transfer pass like every other block.

  worklist = ordered set of all block ids (cfg declaration order)
  changedBlocks = new Set
  iters = 0
  cap = opts?.iterationCap ?? 10000

  while worklist is not empty:
    if iters++ > cap: throw
    blockId = worklist.shift(); block = cfg.blockById(blockId)

    if block === cfg.entry:
      inEnv = initial
    else:
      inEnv = lattice.bottom
      for pred in block.predecessors:
        inEnv = lattice.join(inEnv, outEnv[pred.id])

    newOut = transferBlock(inEnv, block)
    if not lattice.equals(outEnv[blockId], newOut):
      outEnv[blockId] = newOut
      changedBlocks.add(blockId)
      for succ in block.successors:
        if succ.id not in worklist: worklist.add(succ.id)

  return { envs: outEnv, changedBlocks }
```

Structural differences vs `kildall.ts`:
- Tracks `changedBlocks` across the whole run.
- No other semantic differences.

### Why this resolves Phase 8's DFS-bottom trap

Phase 8's per-block `cycle_fn` cells were *demand-driven*: mid-recursion
a cell would return its provisional `bottom` to satisfy a recursive
`db.get` call, and the pessimistic transfer over empty env widened to
TOP. The semi-naive loop structurally cannot reproduce that: every
`outEnv[b]` is initialized to `lattice.bottom` before the first
`transferBlock` call, so every predecessor read during any iteration
returns a value monotonically ≥ bottom. The loop is the same Kildall
worklist that `kildall.ts` already ships — Phase 8's bug was never in
the iteration strategy; it was in letting `cycle_fn` run pure cells
with provisional reads instead of bottom-initialized stored values.

### Integration shim (Phase 9-C/9-D)

- Cell keys stay `unitId`-level. Returned shape stays
  `ReadonlyMap<BlockId, MutableEnv<L>>` (destructure `envs` from the
  evaluator result and discard `changedBlocks` for 9-C/9-D). This is a
  one-line swap at each call site in `block-envs.ts`.
- Dep edges unchanged: `astOf(unit)`, `cfgOf(unit)` (transitively), and
  one `runtimeWrite.get` per node in the CFG via `gatherObservations`.
- Stateless: no state persists across `db.get` calls; the dirty-set
  lives only within one invocation.
- `kildall.ts` gets deleted in 9-D after both queries are migrated.

### 9-E hook (scouting note only)

Per-block invalidation (plan §"Phase 9 success criteria" item 2) is not
deliverable by swapping `kildall` for `semiNaive` alone. The Salsa cell
is still keyed at unit level; any read of `runtimeWriteInput(n)` for
any `n` in the unit reds the whole cell. `changedBlocks` is the input
the Query layer would need to *expose* per-block invalidation — but
doing so requires either (a) splitting the cell into per-block cells
(which re-opens Phase 8's question 4 — never-read blocks' dep
recording), or (b) a new Db primitive that lets a cell selectively
red its dependents based on a per-block predicate.

Neither is small. Flagged for 9-E:
- Recommended path for 9-E: option (a) with the evaluator's
  `changedBlocks` driving a prewarm-with-deps pass that registers
  `runtimeWrite` edges even for never-read blocks (precisely the gap
  question 4 names). Research-adjacent but the evaluator's dirty-set
  gives us the signal question 4 was asking for.
- If (a) blocks on the same reason Phase 8 did, stop at 9-D with a
  documented gap and the refactor is still a net win: module boundary,
  change-signal surfaced, Kildall-precision preserved.

### What to ship in 9-B

- `src/specialization/runtime/datalog/semi-naive.ts` — the evaluator
  as specified above.
- `src/specialization/runtime/datalog/semi-naive.test.ts` — unit
  tests for: monotone join convergence, idempotence, change-propagation,
  bottom-init discipline, iteration-cap throw. No integration yet.


---

## Round 4 Phase 9-E — per-block invalidation deferred (structural block)

Plan §"Phase 9 success criteria" item 2 asks for a test proving that
`typeOf` on a node in an acyclic post-loop block does not invalidate when
`runtimeWrite` lands on a node inside the loop body. After 9-C/9-D the
external shape of `typeBlockEnvs`/`constBlockEnvs` is unchanged — both
are single cells keyed by `unitId`, each reading every node's
`runtimeWriteInput` via `gatherObservations(collectAllIds(cfg))`.

### Why the test cannot pass in the current cell shape

Dependency edges are established at `db.get`-read time. For
`typeBlockEnvs(unit)` to re-run conditionally on *which* block an
observation lands in, the cell would have to read node-level
observations selectively — but the whole-unit Kildall fixpoint requires
the full observation set to produce a correct env map. Narrowing the
set of reads narrows the invalidation trigger *and* narrows the
evaluator's input, breaking correctness. So on a unit-level cell, any
`runtimeWriteInput.set(n, v)` for any `n` in the unit makes
`typeBlockEnvs(unit)` red by construction.

This is not a semi-naive evaluator issue. It is a Query-cell-granularity
issue. The semi-naive swap surfaces `changedBlocks`, which could power
*downstream* per-block invalidation (which `typeOf`/`constOf`
projections to skip), but the gating `typeBlockEnvs` cell still has to
re-run to produce the signal.

### What shipping per-block invalidation would require

Exactly what DECISIONS §"Phase 8 — SCC-aware cycle_fn spike" and
§"Round 2 Phase D" already enumerated, now re-stated with the semi-naive
layer in place:

1. **Split into per-block cells**: `typeBlockOut(unitId, blockId)`, each
   reading `runtimeWriteInput` only for nodes inside that block.
2. **Per-block cells form an SCC along CFG back-edges**: same structural
   shape as Phase 8 path (1). The semi-naive evaluator gives a
   Kildall-precise least fixpoint when run on the whole unit; it does
   *not* retrofit onto a demand-driven multi-cell SCC in Salsa without
   answering the five Round 2 Phase D open questions.
3. **Dep-recording for never-read blocks** (Round 2 Phase D question 4):
   under path Y the answer is "rule-body atoms" — the evaluator's body
   reads every predecessor, so deps get registered. But those reads
   occur *inside the evaluator*, not at the Salsa layer. Salsa would
   need a new primitive allowing a cell to declare "I read these
   fact-cells during iteration even if they weren't observed through
   db.get." Neither architect in 9-A resolved this.

Net: delivering the 9-E test is back to the full Phase 8 path X scope.
No overnight-sized hack sidesteps it.

### Decision

Stop at Phase 9-D, per the plan's explicit escape. The semi-naive
refactor shipped its honest wins:

- Module boundary (`src/specialization/runtime/datalog/`) in place for
  future substrate work.
- `kildall.ts` deleted — single iteration engine used by both analyses.
- `changedBlocks` return value exposed on the evaluator; any future
  per-block or delete-rederive work has a concrete signal to build on.
- No regression (37 → 38 suites, 2586 → 2592 tests; the +1 suite is
  semi-naive.test.ts's seven tests minus the one deleted kildall
  iteration-cap test).

Per-block invalidation ("the genuine payoff") is deferred to the same
trigger the Phase 8 retrospective named: revisit only when a profiler
shows per-unit re-runs dominating hot-path cost, or a new analysis
needs per-block granularity for correctness. As with Phase 8, the
per-unit cell matches the legacy worklist drain coarseness — so this
is no regression vs status quo, it is the plan's anticipated landing.

### What the 9-F retrospective should say

The Round 4 refactor is best understood as a **rename + exposure of a
signal that enables a future refactor**, not as a precision or
invalidation improvement. Calling it "Datalog" is aspirational framing
against the literature (IncA/DRedL) rather than a semantic change over
Kildall on the current non-goals. The honest value is:

1. Future work to split `typeBlockEnvs` into per-block cells has a
   signal (`changedBlocks`) it didn't have before.
2. `kildall.ts` and the standalone iterator are gone; there is now one
   module responsible for all forward-DFA fixpoint iteration in this
   codebase.
3. No new correctness traps were introduced; the previously-shipped
   Kildall precision is preserved bit-for-bit.


---

## Round 4 — Phase 9 retrospective

### Scope actually shipped (HEAD = d8f7621)

- 9-A: architecture note (DECISIONS §9-A).
- 9-B: `src/specialization/runtime/datalog/semi-naive.ts` evaluator +
  `src/tests/runtime/semi-naive.test.ts` unit tests.
- 9-C: `typeBlockEnvs` body delegates to `semiNaive`.
- 9-D: `constBlockEnvs` ported too; `kildall.ts` deleted; runtime index
  re-export dropped; block-envs iteration-cap test absorbed into
  semi-naive.test.ts.
- 9-E: deferred (structural blocker documented).
- Final: **38/38 suites, 2592 tests passing.** Net delta vs Round 4 base:
  6 commits, ~350 LoC added, 118 LoC removed.

### What this refactor actually changed

1. **Module boundary**: `src/specialization/runtime/datalog/` now owns
   all forward-DFA fixpoint iteration. Extensions (cross-analysis
   rules, delete-rederive incrementality, per-block invalidation) have
   an obvious landing zone.
2. **`changedBlocks` signal exposed**: every run of the evaluator
   surfaces the set of blocks whose OUT strictly increased. Today it
   is discarded at the call site; any future refactor wanting per-block
   invalidation, stratified iteration feedback, or telemetry has this
   signal for free.
3. **Single iteration engine**: `kildall.ts` is gone. One function
   (`semiNaive`) handles every per-unit fixpoint the specialization
   framework runs.

### What this refactor did not change

- Iteration complexity: identical to the former Kildall worklist.
- Precision: identical — bottom-init + leq-gated re-enqueue is the
  same Kildall least fixpoint.
- Invalidation granularity: unchanged — `typeBlockEnvs(unit)` still
  has one cell per unit; any `runtimeWrite` on any node reds it.
- Cell dep graph: same `astOf(unit)`, `cfgOf(unit)`, and per-node
  `runtimeWriteInput` edges.
- External API: every `db.get(typeBlockEnvs, …)`, `db.get(typeOf, …)`,
  etc. call site is bit-for-bit unchanged.

### Honest verdict

The path Y "Datalog substrate" claim is aspirational framing against
the IncA/DRedL/IncIDFA literature, not a semantic change over Kildall
on the current non-goals. On a monotone single-lattice forward DFA with
TypeScript closure transfer and no rule DSL, semi-naive Datalog collapses
to the Kildall worklist. The refactor's value is structural preparation:
a module boundary and a surfaced signal that make per-block invalidation
(the genuine payoff both Phase 8 and Round 3 named) a more tractable
future change, not today's change.

If a future maintainer reads the plan expecting Datalog-grade precision
or automatic per-block incrementality, they should read DECISIONS §9-A
("Honest framing up front") and §9-E ("What shipping per-block
invalidation would require") before starting. The plan's §Steelman #2
was correct: Salsa-style demand-driven memoization for Kildall at
py-slang's scale is not the wrong substrate; it is already the right one.
The question was always whether to go further, and Round 4 concluded the
answer is "not without a new runtime primitive for declaring deps on
never-read cells, which is out of overnight scope."

### Follow-on triggers (when to reopen)

- Profiler shows per-unit `typeBlockEnvs`/`constBlockEnvs` re-runs
  dominating hot-path cost on realistic programs.
- A new analysis needs per-block granularity for correctness (e.g.
  path-sensitive analysis where unit-level join over-widens).
- The evaluator's `changedBlocks` signal acquires a downstream consumer
  (e.g. incremental codegen patching specific block's opcodes).
- Conductor grows a persistent-interpreter evaluator that re-uses the
  same Db across chunks, making cross-chunk per-block caching worth
  the complexity.

Until any of these fire: the shipped architecture is architecturally
stable — a deliberate choice, not a compromise.
