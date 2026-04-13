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
