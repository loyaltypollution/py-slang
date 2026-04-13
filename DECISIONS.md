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

## Phase 2 — Db lifecycle

`Db` lives as `protected db: Db` on `PyCseEvaluatorBase`, re-instantiated per `evaluateChunk`. No module-level singleton. Phase 3+ queries reach it via the evaluator class.
