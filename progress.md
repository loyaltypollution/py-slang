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

## Phase 1 — done

- `BasicBlock.unitId: FunctionId` → `unit: Function`. Direct reference replaces
  the foreign key. Builder in `buildCFG` already had `unit` in scope, so the
  field initialisation is just `unit` instead of `unit.funcAst.id`.
- All 4 internal call sites updated:
  - `dfa-factory.ts` stale-block eviction now compares `b.unit === unit`.
  - `dfa-factory.ts` envAnalysis `transfer` reads `block.unit` directly,
    eliminating one `asProgramCtx` cast and the `undefined` guard that could
    never fire (a block always has an owning function — that was an
    impossible-state branch).
  - `purity/analysis.ts` block-fact subscription wake collapses to
    `unitOf((key as BasicBlock).unit)`; the `owner !== undefined ? … : []`
    branch was likewise dead.
  - `function-resolver.ts` `functionOfBlock` is now `(_ctx, block) => block.unit`.
    The whole resolver helper is now ceremony — Phase 3 will inline it away.
- Tests: `type-assumption.test.ts` × 4 sites replaced
  `worklist.functions.get(block.unitId)!.cfg.entry` with `block.unit.cfg.entry`.

Smells noticed:
- Two impossible-state branches went away with the reference change. That's
  evidence: foreign-key indirection had been forcing defensive `undefined`
  handling at every call site even though the structural invariant guaranteed
  the lookup would succeed. Generalising: where you're forced to write code
  for a state that "can't happen", the data shape is usually wrong.
- `function-resolver.ts` is now nearly content-free — every helper is a
  one-liner over a direct reference or a single map lookup. Slated for
  inlining/removal in Phase 3.

## Phase 2 — done

Doc-only. Re-read every `FunctionId` and `ParamKey` use. Both are already
respected as boundary keys at the implementation level — the gap was that the
*definitions* didn't say so explicitly, so a future reader could plausibly
"helpfully" replace `funcAst.id` with a `Function` reference at a counter or
channel call site and break the stable-serialisable-identity contract.

Updates:
- `FunctionId` doc now explicitly labels it a boundary key, lists the
  surfaces (counters, channels, AssumptionChain, ParamKey), and states the
  rule: internal relations use references, boundaries use ids.
- `ParamKey` doc gains a "do not migrate to a Function reference" line with
  the reason (encoding survives across observation channels and chain
  bindings whose stable identity is the contract).

No code change. Tests still 810/810.

## Phase 3 — done

The big one. Killed `ProgramCtx`, `asProgramCtx`, the `FunctionView` registry,
and the `function-view.ts` module. `AnalysisCtx` is now what its docstring
always claimed it was: a generic transfer-time surface with no view-shape
accessors.

Architecture:
- New `program/views/function-locator.ts` — read-only program-wide lookup
  surface: `functions()`, `functionById`, `functionForAst`,
  `functionContainingNode`, `blockContaining`. Manager implements it.
- `Worklist.locate: FunctionLocator` is the single seam consumers use. The
  old `worklist.functions` Map and `worklist.functionOfNode` forwarders are
  gone; tests adopted `worklist.locate.functionById(id)` /
  `worklist.locate.functionContainingNode(id)`.
- `FunctionId` moved out of the dying `function-view.ts` into `function.ts`
  (the file that already declares `Function`, whose `funcAst.id` IS this
  type). `function-view.ts` deleted.
- `program-ctx.ts` deleted (`ProgramCtx`, `asProgramCtx`).

Migration:
- All cast sites replaced with explicit dependencies:
  - `dfa-factory` `readPerExprDeepest` captures `wl.locate` at
    `factsAnalysis.bind` time and reads via `boundLocator.blockContaining`.
  - `dfa-factory.perExpr(view)` → `perExpr(locator: FunctionLocator)`; cache
    keyed by locator identity (the manager is the single instance per
    program, same identity discipline as before).
  - `purity` block-transfer captures `wl.locate` at
    `purityFunctionAnalysis.bind` time. Resolves nested-FunctionDef ids via
    `boundLocator.functionById(fd.id)`.
  - `param-handles` `resolveUnit` reframed: `(locator, key) => locator.functionById(...)`.
- `FunctionResolver<K>` signature changed from `(ctx, key) => Function | undefined`
  to `(locator, key) => Function | undefined`. The cast layer was the only
  reason the signature ever needed an `AnalysisCtx`.
- Worklist subscription callbacks (`subscribe`, `subscribeOnAdvance`,
  `onMint`, `onRebuildDirty`, `onSpecRev`, `onTransformFactDirty`,
  `onTransformCounterBumped`) had their `dirtied: (ctx, key) => Iterable<K>`
  signature changed to `(locator, key) => Iterable<K>`. Existing call sites
  all used `(_ctx, ...)` — never read the ctx — so this was a strict
  signature tightening. Internal `enqueueAt` projection still uses the
  per-write ctx for chain context; that's not part of the dirtied surface.
- Transforms migrated from `view: FunctionView` parameter to
  `locator: FunctionLocator` (mechanical rename across
  algebraic-simplify, constant-folding, dead-branch, dead-store, memoization,
  speculation/chain-dispatch, dfa-query). The `view` name was always wrong
  here; it carried a registry, not a view object.
- `dfa-query.makeDfaQuery` took the (`FunctionView`, optional duck-typed
  future-dispatch) shape. Now takes `(FunctionLocator, futureDispatchChainForNode?)`
  with the future-dispatch hook as an explicit second argument. Phase 5
  will further untangle that callback from the locator.

Smells noticed:
- `function-resolver.ts` left in place — its helpers (`functionOfBlock`,
  `functionOfNodeId`, `functionOfFunctionId`) are now one-liners over the
  locator. They earn their keep as call-site documentation but are
  inlineable. `wakeOwningFunction` is more substantive (turns a unit
  resolver into an iterable wake). Worth revisiting in Phase 6 alongside
  the broader transform-capability narrowing.
- `Worklist.passCtx` is still around (used by `bump` for counter dispatch
  and as a default ctx for the sweep path). Phase 6's "transforms receive
  only the read/query capabilities they need" will probably eat it.
- Many of the existing `(_ctx, key) => …` callbacks revealed an old
  generalisation that never got used: every dirtied callback received a
  per-write `AnalysisCtx`, but no caller ever read it. Either the
  generalisation was speculative, or it was intended to give callbacks
  access to the chain — which they got via the enqueue path anyway.
  Either way, the simpler signature was always available.
- The deletion of `ProgramCtx` removed the only place where the framework's
  generic ctx interface was widened with view-shape concepts. The
  vocabulary now actually holds the line the comments always claimed it
  did. (Several stale comments referenced `asProgramCtx`/"richer ctx" —
  cleaned up.)

## Phase 4 — done

Bookkeeping phase — extracts the kind-agnostic shell out of FunctionManager.

- New `program/views/view-manager.ts` with `ViewManager<V extends View>`.
  Generic shell only: `values()`, `onMint(cb)`, `onRebuild(cb)`. Per-kind
  lookups (`functionById`, `blockContaining`) are NOT in the shell — they
  live on the kind-specific manager / its `Locator` companion. The reason
  is the same one that motivates the Locator/Manager split: a hypothetical
  `LoopManager` has no `functionById`, so generic code must not depend on
  one.
- Renamed: `function-view-manager.ts` → `function-manager.ts`,
  `FunctionViewManager` → `FunctionManager`. The field on Worklist became
  `functionManager` to match.
- `FunctionManager` now declares `implements ViewManager<Function>,
  FunctionLocator`. The lifecycle (`onMint`/`onRebuild`) signatures already
  matched the generic shell — only `functions()` had to change to `values()`
  to satisfy `ViewManager.values()`. `FunctionLocator.functions()` was
  unused by any caller, so it left with the rename.

What did NOT change in Phase 4:
- Worklist still keeps `functionManager: FunctionManager` (concrete) rather
  than a `Map<ViewKind, ViewManager<V>>`. There is exactly one view kind
  today; introducing the generic store before a second kind exists is the
  premature-architecture trap the user explicitly flagged in memory. When
  a `LoopManager` actually arrives, the shell is ready to receive it.
- Generic lifecycle loops in Worklist still mention `Function` (because
  every callback fans out to per-Function dirty sets). Phase 6's
  `TransformRule<V>` work is the right place to push the generic plumbing
  the rest of the way.

Smells noticed:
- The `FunctionLocator` interface and the `FunctionManager` class both
  carry "function" in their name and live one directory apart. That's
  fine while there's one kind; it would become noise if we end up with
  `FooLocator` + `FooManager` per kind. Worth revisiting if a second view
  kind ever lands — the locator may want to be inlined into the manager.

## Phase 5 — pending





