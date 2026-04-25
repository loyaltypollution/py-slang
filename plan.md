# Specialization framework cleanup — tracking sheet

## Thesis

Only `NodeId` is real. `Function`, `BasicBlock`, `Loop`, ad-hoc sets are **named subsets of NodeIds**. Producers announce **deltas as NodeSets**; subscribers declare **interest as NodeSets**; Worklist routes by `delta ∩ interest`. Producers never enumerate consumers; consumers never name producers' privileged containers.

## Gate per step

`tsc` clean (excluding pre-existing parser errors) and 810 specialization tests pass. Commit per landing step.

## Queue

### In progress
- (none — picking next from smells list)

### Open — priority order

1. **Phase 5.E (deferred): lifecycle wrappers.** ~10 callers; defer until 2nd view kind motivates generalization.
2. **Phase 5.G (deferred): `View extends NodeSet { id: NodeId; kind: string }`.** Codify after lifecycle generalization decision.

### Done (latest first)
- Item 10 (smells): synthetic-block empty-NodeSet contract documented on `BasicBlock.nodeIds` and `Worklist.subscribe`; regression test in `node-set.test.ts` asserts stmts-empty ↔ nodeIds-empty.
- Items 1–9: see commit log on branch `specialization-engine`. Briefly:
  - 1: dropped `FunctionId` from framework; canonical home is `program/program-view`.
  - 2: `NodeSet.size`/`iterate` + free `intersects(a, b)` + Function/BasicBlock NodeSet conformance.
  - 3: `subscribe` interest is `NodeSet`; routing via `intersects`. Purity → `internSingletonNode`.
  - 4: `writeAndDispatch` defaults `delta = key`; legacy fan-out fallback gone.
  - 5: collapsed `onFactDirty`/`onFactDirtyNodeSet` into `subscribe`.
  - 6: dfa-query dropped `isPureScope`/`entryRequirementsOf`. Folded `factSubs` → `nodeSetSubs` (bonus).
  - 7: `makeDfaQuery(view)` auto-derives futureDispatchChainForNode when supported.
  - 8: `BasicBlock.nodeIds` = exclusive CFG ownership; nested scopes/bodies excluded.
  - 9: split `subscribeOnAdvance` from `subscribe`; cell-identity vs node-intersection are now distinct primitives.

### Newly-spotted smells (investigate later)
- **`Worklist.onMint`/`onRebuildDirty`/`onSpecRev`/`onRefute` wrappers.** Function-typed thin wrappers around `functionViews.on*`. ~10 callers. With one view kind, generalizing is premature; deleting forces boilerplate at call sites. Revisit when a 2nd view kind exists OR when consolidating subscription primitives (could lifecycle events be modeled as `subscribe` over a synthetic "lifecycle" analysis?).

## Notes / decisions log
- (kept thin; commit messages carry per-step rationale)
