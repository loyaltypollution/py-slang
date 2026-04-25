# Specialization framework cleanup — tracking sheet

## Thesis

Only `NodeId` is real. `Function`, `BasicBlock`, `Loop`, ad-hoc sets are **named subsets of NodeIds**. Producers announce **deltas as NodeSets**; subscribers declare **interest as NodeSets**; Worklist routes by `delta ∩ interest`. Producers never enumerate consumers; consumers never name producers' privileged containers.

## Gate per step

`tsc` clean (excluding pre-existing parser errors) and 807 specialization tests pass. Commit per landing step.

## Queue

### In progress
- (none — picking next from smells list)

### Open — priority order

7. **Smell: `makeDfaQuery` boilerplate at call sites.** `nodeId => worklist.futureDispatchChainForNode(nodeId)` is duplicated at 3 call sites. Default the chain resolver from the worklist when none is passed.
8. **Phase 5.E (deferred): lifecycle wrappers.** ~10 callers; defer until 2nd view kind motivates generalization.
9. **Phase 5.G (deferred): `View extends NodeSet { id: NodeId; kind: string }`.** Codify after lifecycle generalization decision.

### Done
- Item 1: dropped `FunctionId` from `framework/analysis.ts`; canonical home is `program/program-view.ts`.
- Item 2: added `NodeSet.size`/`iterate` (both optional) and free `intersects(a, b)`; enriched Function (via `nodeToBlock.keys()`) and BasicBlock (via per-block `nodeIds: Set<NodeId>` populated in `wireCFG`).
- Item 3: `onFactDirtyNodeSet` interest is now `NodeSet`; routing uses free `intersects`. Purity migrated to `internSingletonNode`.
- Item 4: `writeAndDispatch` defaults `delta = key`; legacy unconditional-fan-out fallback removed. Per-key transfers now correctly intersection-gate nodeSet subscribers.
- Item 5: collapsed `onFactDirty`/`onFactDirtyNodeSet` into single `subscribe(from, reader, interest, dirtied)`. `ANY_NODESET` sentinel short-circuits intersection (identity-mode), needed because keys can have empty NodeSet membership (e.g. backward-DFA exit block).
- Item 6: dfa-query.ts dropped `isPureScope`/`entryRequirementsOf` (zero non-test consumers, bifurcated API by view kind). `FunctionView` handle retained — it's the legitimate seam for `perExpr` block-keyed → node-keyed materialization.
- Bonus: folded `factSubs` into `nodeSetSubs`. `onTransformFactDirty` now routes through the same delta-aware machinery (with ANY_NODESET interest); transforms can opt into narrower interest if/when useful.

### Newly-spotted smells (investigate later)
- **`ANY_NODESET` is a two-mode sentinel.** It signals "identity-mode subscription" (fire on every advance), not "set with all node ids." This is a real concept — a cell-identity dependency vs a node-membership dependency. Worth promoting to a named distinction in the API (`subscribe` vs `subscribeOnAdvance`?), or at least documenting the two-mode contract on `subscribe` more visibly. Consider when next touching the subscription primitive.
- **Block exit/entry have empty `nodeIds`.** Block NodeSet membership = AST nodes inside. Synthetic blocks (entry, exit, loop joins) have no AST nodes, so their NodeSet is empty. Anyone using a block as `interest` for a *node-level* subscription gets vacuously-false intersections at synthetic blocks. Document in `BasicBlock` interface or rethink: should synthetic blocks include a synthetic id in their NodeSet?
- **`Worklist.onMint`/`onRebuildDirty`/`onSpecRev`/`onRefute` wrappers.** Function-typed thin wrappers around `functionViews.on*`. ~10 callers. With one view kind, generalizing is premature; deleting forces boilerplate at call sites. Revisit when a 2nd view kind exists OR when consolidating subscription primitives (could lifecycle events be modeled as `subscribe` over a synthetic "lifecycle" analysis?).
- **`SVMLCompiler.fromProgramUnit` ergonomic.** 3 call sites (PySvmlJitEvaluator, two test runners) all pass `(ast, environments, makeDfaQuery(worklist, nodeId => worklist.futureDispatchChainForNode(nodeId)))`. The `nodeId => worklist.futureDispatchChainForNode(nodeId)` is verbatim repetition. Either bake it into `makeDfaQuery(worklist)` (default the chain resolver from the worklist), or make it a method `worklist.makeDfaQuery()`. The lambda is duplication that should disappear.

## Notes / decisions log
- (kept thin; commit messages carry per-step rationale)
