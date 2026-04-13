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
