# Specialization view-contract refactor — progress log

Tracks per-phase work for `plan.md`. Each phase: tsc clean (baseline = 2 pre-existing
parser errors in `python-grammar.ts`), 810 specialization tests green, one commit.

Deviation from `plan.md` (agreed before starting):
- Phase 0 keeps the `FunctionView` and `FunctionViewManager` filenames/types in place.
  Renames happen at the phase that already restructures or deletes them — `FunctionView`
  dies in Phase 3, `FunctionViewManager` becomes `FunctionManager` in Phase 4. Renaming
  earlier just to rename again is churn.

## Phase 0 — done

- Added `src/specialization/program/views/view.ts` with `View extends NodeSet` marker.
- `Function` and `BasicBlock` now `extends View`. No structural change — `View`
  contributes nothing beyond the existing `NodeSet` shape both already implemented.
- Documented the registry-vs-view distinction at `function-view.ts` (registry
  surface, not a view) and `function-view-manager.ts` (manager for the Function
  view kind, scheduled to become the `FunctionManager` + `ViewManager<V>` split).
- Renames deferred: `FunctionView` dies in Phase 3, `FunctionViewManager` →
  `FunctionManager` in Phase 4.

Smells noticed (not yet acted on):
- `FunctionId` doc references `functions.get(id)` AND `functionOfNode(id)` having
  two meanings — the comment is informative but a sign that one boundary id is
  doing two jobs (root key for the function-view, vs. a node id you happen to be
  asking about). The current shape is fine but worth revisiting in Phase 3.
- `function-resolver.ts` exists only because `AnalysisCtx` doesn't expose program
  shape; every helper is a one-line `asProgramCtx(ctx).functions.get(...)` cast.
  Once Phase 3 adds explicit locators this file becomes pure forwarding.

## Phase 1 — pending

