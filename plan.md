# Specialization framework cleanup — tracking sheet

## Thesis

Only `NodeId` is real. `Function`, `BasicBlock`, `Loop`, ad-hoc sets are **named subsets of NodeIds**. Producers announce **deltas as NodeSets**; subscribers declare **interest as NodeSets**; Worklist routes by `delta ∩ interest`. Producers never enumerate consumers; consumers never name producers' privileged containers.

## Gate per step

`tsc` clean (excluding pre-existing parser errors) and 807 specialization tests pass. Commit per landing step.

## Queue

### In progress
- (none)

### Open — priority order

1. **Kill `FunctionId` from `framework/analysis.ts`.** It's `number` and semantically `NodeId`. Keep a local alias in `program/program-view.ts` for files that want the semantic name. Pure rename.
2. **Add `NodeSet.intersects(other: NodeSet): boolean`** with optional size hint so impl picks the smaller side.
3. **Change `onFactDirtyNodeSet` interest from `Iterable<NodeId>` to `NodeSet`.** Singleton callers keep working.
4. **Audit producers; add `delta: NodeSet` at every `ctx.write`** whose advance is naturally per-node (typeAnalysis, constAnalysis, livenessAnalysis).
5. **Collapse `onFactDirty` and `onFactDirtyNodeSet` into one API** — `subscribe(from, interest: NodeSet, fire, opts?)` with an `ANY_NODESET` sentinel for whole-key.
6. **Rewrite `dfa-query.ts` as a thin facade** over `analysis.store.{tryRead, readDeepest}`. Drop `scopeId: FunctionId` privilege.
7. **Phase 5.E (deferred): kind-discriminated lifecycle subs OR remove Worklist's Function-typed wrappers.** Current `worklist.onMint/onRebuildDirty/onSpecRev` are Function-shaped wrappers around `functionViews.on*`. Either generalize via `kind` discriminator, or just delete the wrappers and have analyses subscribe via `wl.functionViews.onMint(...)` directly. Pick when a 2nd view kind is in sight.
8. **Phase 5.G (deferred): `View extends NodeSet { id: NodeId; kind: string }`.** Codify after lifecycle generalization decision.

### Done
- (none yet)

### Newly-spotted smells (investigate later)
- (add as encountered)

## Notes / decisions log
- (kept thin; commit messages carry per-step rationale)
