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

## Phase 5 — done

Speculation-policy state extracted into a composed `FunctionDispatchState`
class living in `program/views/function-dispatch.ts`. The split is the
honest one: a Function's "what nodes do I own / what's my CFG" is
orthogonal to "what chain do I want to dispatch under next". Conflating
them was the structural reason `dfa-query.ts` had to duck-type
"future dispatch" off the registry interface (already cleaned up in
Phase 3, now firmed up here).

Moved out of FunctionManager:
- `futureDispatchContextByUnit` Map
- `futureDispatchChainFor`, `setFutureDispatchContext`, `clearFutureDispatchContext`
- `onSpecRev`, `fireSpecRev`
- `onRefute`, `refuteSubscribersAndReconcileDispatch` (latter renamed to
  `fireRefuteAndReconcile` — the new name says what it does, not which
  subscribers it touches)

What stayed on FunctionManager:
- `futureDispatchChainForNode(nodeId)` — bridges the locator
  (`functionContainingNode`) and dispatch (`futureDispatchChainFor`).
  Lives on the manager because that's the one type that already owns
  both surfaces; the alternative is a free function that takes both.

Worklist call sites now read `this.functionManager.dispatch.foo()` for
all speculation operations. The extra hop is the point — it makes the
layer visible at the call site.

Acceptance:
- speculation policy no longer conflated with registry/lifecycle code ✓
- dfa-query future-dispatch access is explicit (Phase 3 work) ✓

Smells noticed:
- `Worklist` still exposes `futureDispatchChainFor` and
  `futureDispatchChainForNode` as direct methods (line 718-724),
  forwarding to `functionManager.dispatch.*`. These are convenience
  forwarders — internal callers in worklist.ts now go direct, but
  external callers (tests, jit-dispatch) still use them. Could be
  removed in Phase 6 alongside the broader transform-capability
  cleanup, or left as a stable Worklist surface. Judgment call.

## Phase 6 — done

Two targeted typing changes:

1. `TransformRule<V extends View = Function, P = FunctionLocator>`. The
   old defaults were `<V = unknown, P = unknown>` — nothing in the type
   said "V is a view"; the constraint was carried only by docstrings.
   Now the type encodes what the docs already claimed: a transform
   operates on a concrete program region (View), and receives a
   program-handle (P). A hypothetical `LoopManager` + `TransformRule<Loop>`
   wires up without changing TransformRule itself.

2. New `TransformBindCtx` interface — narrow capability surface offered
   to `TransformRule.bind`. Exactly:
   - `onTransformFactDirty(rule, from, dirtied)`
   - `onTransformCounterBumped(rule, counter, dirtied)`
   - `onRefute(cb)`
   That's the full set every existing transform actually uses. The
   `bind?(worklist: Worklist)` signature changed to `bind?(ctx: TransformBindCtx)`.
   Worklist still satisfies the interface structurally, so existing call
   sites compile unchanged — but a transform reaching for, say,
   `wl.write(...)` or `wl.tryRead(...)` from inside `bind` no longer
   type-checks.

Verified: every transform's `bind` only touches the three permitted
methods (grep confirmed). Tests 810/810 throughout.

What was deferred (and why):
- `transformDirty: Map<TransformRule, Set<Function>>` was NOT generalised
  to `Set<V>`. Doing so requires runtime view-kind tagging or a
  per-kind dirty store on Worklist; both are premature when there is
  exactly one view kind. The TransformRule generics now make the
  TypeScript-level decision visible the day a second kind lands —
  which is the right time to pick.
- `Worklist.passCtx`, the convenience forwarders
  `worklist.futureDispatchChainFor(unit)` /
  `futureDispatchChainForNode(nodeId)`, and the `function-resolver.ts`
  one-line helpers (`functionOfBlock`, `functionOfNodeId`,
  `functionOfFunctionId`) are still around. They earn their keep at
  external call sites (tests, jit-dispatch, transform `bind`s) and the
  alternative is a wider blast-radius rename for marginal benefit.

Plan acceptance:
- a hypothetical LoopManager + TransformRule<Loop> wire up without
  framework surgery ✓
- transforms cannot accidentally depend on unrelated Worklist powers ✓
- DFA query helpers take explicit locator + explicit future-dispatch
  callback (Phase 3 work) ✓

## Wrap-up

Across the six phases:
- 6 commits, 810 specialization tests green throughout, no behavior change.
- Deleted: `program-ctx.ts`, `function-view.ts`, the `asProgramCtx` cast
  layer, the `ProgramCtx extends FunctionView` widening, the
  `worklist.functions` Map / `functionOfNode` forwarders, the duck-typed
  future-dispatch detection in `dfa-query`.
- Added: `View` marker interface, `FunctionLocator` (proper read surface),
  `ViewManager<V>` shell, `FunctionDispatchState` (speculation policy
  separated from registry/lifecycle), `TransformBindCtx` (narrow transform
  capability).
- Renamed: `BasicBlock.unitId: FunctionId` → `unit: Function`,
  `FunctionViewManager` → `FunctionManager`. `FunctionId` migrated from
  the dying `function-view.ts` to `function.ts`.

The architecture now reads as plan.md's end state describes:
- `NodeId` = atomic address
- `NodeSet` = routing geometry
- `View` = concrete program region (`Function`, `BasicBlock`)
- `ViewManager<V>` = lifecycle/index for one kind
- `FunctionLocator` = read surface for the Function kind
- `FunctionDispatchState` = speculation policy for the Function kind
- runtime ids (FunctionId, ParamKey) = boundary keys only

Cross-cutting smell observations to revisit:
- `function-resolver.ts` survived but is one-line sugar over the locator —
  inline candidate when transform `bind` ergonomics get attention.
- `Worklist.passCtx` survived — used by counter dispatch and as a default
  in the sweep path. Worth a closer look as part of a future sweep
  cleanup, not as part of this view-contract pass.

## Phase 7 — done

Walked back the speculative `ViewManager<V>` abstraction. plan.md (the
post-Phase-6 doc) explicitly rejects "every view kind gets a universal
manager interface", and ViewManager had exactly one consumer
(`FunctionManager`) plus a docstring promising future LoopManager /
RegionManager kinds — textbook speculative genericity.

Changes:
- Deleted `src/specialization/program/views/view-manager.ts`.
- `FunctionManager` drops `implements ViewManager<Function>`. The methods
  it exposed for the interface (`values()`, `onMint`, `onRebuild`) stay
  as plain methods. When a real second view kind arrives, the right
  shared shape will be extracted from two consumers, not from one.
- Header comment on `FunctionManager` now states the three-question
  contract for `Function` (materialized by manager / looked up via
  FunctionLocator / rebuilt as the root scheduling unit) and explicitly
  calls itself the *concrete* owner of the function-rooted world, not
  a generic template.
- Header comment on `BasicBlock` states the subordinate version
  (materialized by `buildCFG` inside the owning function / looked up by
  direct reference or per-function index / rebuilt wholesale on function
  rebuild).
- Header comment on `View` itself now says explicitly that View is the
  only universal contract and per-kind machinery is answered separately.

No behavior change. tsc clean (modulo the 2 pre-existing parser errors).
810/810 specialization tests still green.

Smells noticed:
- The doc tightening on `View` / `BasicBlock` / `FunctionManager` was
  load-bearing precisely because the previous phase's comments
  over-promised. Phase 4's "this generic shell exists so a hypothetical
  LoopManager reuses the lifecycle vocabulary" was speculative
  architecture preserved as a comment — the kind of thing that becomes
  a trap the next reader takes as a blessing.

## Phase 8 — done (decision: document in-place, no extraction)

plan.md asked whether the CFG/block apparatus deserves its own per-function
owner (`FunctionCfg` or similar). Decision: no extraction. `wireCFG` plus
`cfg`, `blockMap`, and `nodeToBlock` are a 30-line invariant that is
tighter to read in one place than across two. There is no live consumer
that benefits from the split — `FunctionManager.flushPendingRebuilds`
already drives rebuild, and block lookups already go through the owning
function. Extracting now would be moving things around to satisfy a
hypothetical future need.

Folded into the Phase 7 commit. The Function header now states the
in-place CFG ownership decision explicitly so a future reader knows it
was a deliberate choice, not an accident.

## Phase 9 — done

Added `src/tests/specialization/view-contract.test.ts`. Four invariants
tied to specific call sites:

1. `BasicBlock.unit` references the owning `Function` for every block
   in the function's CFG.
2. `FunctionLocator.blockContaining(n)` agrees with
   `functionContainingNode(n)?.blockOfNode(n)` for every CFG-owned node.
3. `FunctionManager.flushPendingRebuilds` replaces block instances
   wholesale: old block references drop out of `cfg.blocks` and out of
   the locator index; the function reference itself stays stable.
4. `makeDfaQuery` routes speculative reads only through the explicit
   future-dispatch callback — a call-count spy distinguishes static vs.
   speculative reads, pinning that there is no hidden registry
   back-channel.

814/814 specialization tests green (810 prior + 4 new).

## Phase 10 — deferred (correctly)

Triggered only when an actual `Loop` view is introduced. Plan.md is
explicit: don't begin by designing a generic hierarchy; begin by writing
the three answers (materialized / looked up / rebuilt) for Loop. Nothing
to do until that work lands.

## Phase 11 — done

The structural change. Worklist's transform sweep had been hardwired to
Function: dirty sets typed `Set<Function>`, mint/rebuild dirtying went
through `FunctionManager` directly, and `sweepTransforms` read
`futureDispatchChainFor` + `schedulePendingRebuild` off the manager.
`TransformRule<V, P>` had the V slot since Phase 6 but the runtime was
monomorphic. User's call: this is the lever that unblocks Loop-based
analyses and any other root scheduling unit.

New `SweepKind<V>` interface (framework/sweep-kind.ts) names the four
operational questions a transform-sweep granularity has to answer:
mint subscription, rebuild subscription, chainFor(view), scheduleRebuild.
A new view kind ships its own SweepKind impl and the worklist needs no
further surgery.

Worklist refactor:
- `transformDirty: Map<rule, Set<Function>>` →
  `transformEntries: Map<rule, { kind: SweepKind<V>, dirty: Set<V> }>`
- `registerTransform<V>(rule, kind?)` — overload-typed: no-kind form is
  constrained to `TransformRule<Function, any>`, explicit form is
  generic. Existing call sites unchanged.
- `onTransformFactDirty<V, K>` / `onTransformCounterBumped<V, K>` infer
  V from the rule arg; dirtied callbacks return `Iterable<V>`.
- `sweepTransforms` uses `entry.kind.chainFor` / `entry.kind.scheduleRebuild`
  per rule; nothing in the loop knows about Function specifically.

`TransformBindCtx` (analysis.ts) tightens to match — same V inference.

Two load-bearing tests in `sweep-kind-polymorphism.test.ts`:
1. Register a rule under a custom `SweepKind<SynthView>`; pin that mint,
   rebuild, chain selection, and scheduleRebuild all route through the
   custom kind, not through FunctionManager.
2. Custom `chainFor` controls the chain passed to `sweep`.

Without these tests the polymorphism would type-check but rot.

Smells noticed:
- The default-kind injection in `registerTransform` requires one
  internal `as unknown as SweepKind<V>` cast in the implementation
  signature — TS can't prove `SweepKind<Function>` ⊆ `SweepKind<V>`
  without a constraint that doesn't exist at the type system. Isolated
  behind overloads so callers never see it.
- Analysis-side subscriptions (`onMint`, `onRebuildDirty`, `onSpecRev`)
  still take `unit: Function`. That's intentional — they fan out to
  analysis dirty sets keyed by NodeSet, not view kind. If a future Loop
  kind needs Loop-mint-driven analysis seeding, that's a separate
  generalization.

## Phase 12 — done (function-resolver elimination)

`function-resolver.ts` had become a pre-polymorphism artifact: three
one-line wrappers (`functionOfBlock` / `functionOfNodeId` /
`functionOfFunctionId`) plus `wakeOwningFunction` lift. With
`TransformBindCtx` inferring `Iterable<V>` per-rule (Phase 11), nothing
load-bearing remained.

Inlined at every call site:
- 4 transforms (algebraic-simplify, constant-folding, dead-branch,
  dead-store): `wakeOwningFunction(functionOfBlock)` → `(_, b) => [b.unit]`.
  block.unit is non-undefined by construction; the lift step was
  zero-value.
- memoization: `wakeOwningFunction(functionOfFunctionId)` → 3-line
  lambda doing the option→list step explicitly.
- type-requirement: `resolveUnit: functionOfFunctionId` → arrow lambda.

Type-level cleanup:
- `ObservationBinding.resolveUnit`'s typed shape inlined as
  `(FunctionLocator, K) => Function | undefined` — was
  `FunctionResolver<K>`.
- Worklist's per-channel resolver gets a local `UnitResolver` alias and
  a `defaultUnitResolver` constant for the "key is a NodeId, find the
  enclosing function" default.

Why this matters: every consumer was a "do the same thing as Function"
shape that obstructed migration to per-kind dirty fan-out. Removing the
shared resolver helpers makes the polymorphic shape (V inferred from
the rule) the only path. A future Loop transform writes its own lambda;
no shared wrapper has to be generalised.

## Phase 13 — done (FunctionSweepKind consolidation)

`FunctionSweepKind` was a 17-line wrapper class with one consumer
(Worklist) — exactly the "1 consumer → consider inlining" pattern. Folded
into `FunctionManager` directly: it now `implements FunctionLocator,
SweepKind<Function>`. Added `chainFor(unit)` as a one-line delegate to
`dispatch.futureDispatchChainFor`; renamed `schedulePendingRebuild` →
`scheduleRebuild` (the `Pending` was leaking the until-flush
implementation detail, and SweepKind's interface already spells it that
way).

`Worklist.functionSweepKind` is now `this.functionManager` directly,
typed as `SweepKind<Function>` — no wrapper construction.

Pattern this confirms for future kinds: a per-kind manager that owns
lifecycle + lookup naturally implements its own SweepKind. No
intermediate wrapper class needed. A `LoopManager` would `implements
LoopLocator, SweepKind<Loop>` the same way.

## Cumulative state

`program/views/` after this run:
- view.ts (marker — `View extends NodeSet`)
- function.ts (Function + buildOneFunction + wireCFG)
- function-manager.ts (registry + FunctionLocator + SweepKind<Function> +
  lifecycle + composed FunctionDispatchState)
- function-locator.ts (read-only narrow interface)
- function-dispatch.ts (speculation policy, composed)
- basic-block.ts (BasicBlock + buildCFG)

Down from 9 files at the start of this run (deleted: view-manager.ts,
function-view.ts, program-ctx.ts, function-resolver.ts,
function-sweep-kind.ts).

Polymorphic dirty model (Phase 11) is the structural change; everything
else (Phases 7-10 view contract, 12-13 cleanup) is downstream
clarification.

Adding a new root view kind today means:
1. Define `interface MyView extends View` and its construction owner.
2. Implement `SweepKind<MyView>` (mint/rebuild/chainFor/scheduleRebuild)
   — typically on whatever object materialises the views.
3. Register transforms with `registerTransform(rule, mySweepKind)`.
4. No worklist surgery.

## Phase 14 — done (delete `View` marker)

`interface View extends NodeSet {}` was empty — pure nominal bookkeeping. Its
stated purpose ("exclude EMPTY/ANY/singleton from transforms") is enforced at
the registration surface, not by the type. Deleted `view.ts`. `Function` and
`BasicBlock` now `extends NodeSet` directly.

`SweepKind<V extends View>` and `TransformRule<V extends View, P>` constraints
relaxed to `V extends NodeSet` as a one-commit transitional step (both were
removed entirely in Phase 15-18).

814/814 specialization tests green. tsc clean (modulo the 2 pre-existing parser
errors). One commit.

## Phases 15-18 — done (merged: collapse on*, delete SweepKind, monomorphize TransformRule)

Merged because the four phases are tightly coupled — the on* primitives feed
into SweepKind which feeds into TransformRule generics. Splitting them
introduces transitional wrapper types the user explicitly told us to avoid.

### Phase 15: collapse extent stream

`FunctionManager`:
- `mintSubs` + `rebuildSubs` → one `extentSubs:
  Array<(unit, prev: NodeSet, next: NodeSet) => void>`.
- `onMint(cb)` + `onRebuild(cb)` → `onExtentChange(cb)`. Subscribe-time replay
  fires `(unit, EMPTY_NODESET, snapshot)` for every existing unit so late
  subscribers still pick up the burst.
- `addFunction` fires `(unit, EMPTY_NODESET, snapshot)`.
- `flushPendingRebuilds` snapshots `prev` ids before `wireCFG`, fires
  `(unit, prev, next)` after.

Snapshots use `nodeSetOfIds(new Set(unit.nodeToBlock.keys()))` — concrete
NodeSet over the unit's CFG-owned ids at a moment in time.

### Phase 16: collapse chain stream

`FunctionDispatchState`:
- `specRevSubs` → `chainSubs`.
- `onSpecRev` → `onChainChange((unit, prev, next) => void)`.
- `fireSpecRev(unit)` → `fireChainChange(unit, prev, next)`.

Worklist call sites at the two narrowing-driven fire points capture
`priorChain = futureDispatchChainFor(unit)` before any set/clear, then pass
`(unit, priorChain, newCtx)` to `fireChainChange`. The implicit clearing in
`fireRefuteAndReconcile` (when a unit's preferred chain is itself refuted)
deliberately stays silent — the outer ingress path reconciles and fires the
explicit chain delta.

`onRefute(unit, carrier)` stays as-is — semantically distinct from a chain
delta over a unit's preferred chain (the carrier identity matters to
consumers like memoization).

### Phase 17: rewire Worklist + analyses

Worklist: `onMint` / `onRebuildDirty` / `onRebuildEvict` / `onSpecRev` →
`onExtentChange` (analysis-keyed) + `onExtentChangeRaw` (side-effect
listener with `(unit, prev, next)` shape) + `onChainChange`.

`dfa-factory.ts`:
- envAnalysis: one `onExtentChange` for re-seeding + one `onExtentChangeRaw`
  for eviction gated on `prev.size > 0`. Plus `onChainChange` for chain re-seed.
- factsAnalysis: one `onExtentChangeRaw` for eviction.

`purity/analysis.ts`: three on-events collapsed to one `onExtentChange` +
one `onChainChange`.

### Phase 18: delete SweepKind, monomorphize TransformRule

- Deleted `src/specialization/framework/sweep-kind.ts`.
- `FunctionManager` no longer `implements SweepKind<Function>`. `chainFor` and
  `scheduleRebuild` stay as plain methods (already named that way).
- Worklist: `transformEntries: Map<rule, { kind, dirty }>` →
  `transformDirty: Map<rule, Set<Function>>` (back to pre-Phase-11 shape).
  `registerTransform` is single-arg again. `sweepTransforms` calls
  `functionManager.chainFor` / `scheduleRebuild` directly.
- `TransformRule<V, P>` → `TransformRule`. `sweep(unit: Function, chain,
  locator: FunctionLocator) => boolean`.
- `TransformBindCtx<V>` → `TransformBindCtx`. The on-events it exposes are
  Function-shaped.

The polymorphism story is now: when a second root scheduling unit appears,
introduce generics from two consumers, not one. Today there is one root
(`Function`); the framework reflects that.

## Phase 19 — done (test cleanup)

- Deleted `src/tests/specialization/sweep-kind-polymorphism.test.ts` — pinned a
  generality the architecture no longer claims.
- Renamed `view-contract.test.ts` → `function-block-contract.test.ts`. The
  `describe` label now reads "Function/BasicBlock invariants — ownership,
  locator agreement, rebuild semantics". The four invariants themselves are
  unchanged: BasicBlock.unit ownership, locator agreement, rebuild replaces
  blocks wholesale, makeDfaQuery routes speculative reads explicitly.

814/814 specialization tests green. Out-of-scope: `src/tests/svml-stable-indices.test.ts`
fails to type-check against `engine.functions` (a property that has not
existed since Phase 3). Pre-existing rot from a stale call site, not caused
by this work; fixing that test is its own task.

## Cumulative state after this run

`program/views/`:
- function.ts (Function + buildOneFunction + wireCFG + extends NodeSet)
- function-manager.ts (registry + FunctionLocator + extent stream + chainFor
  + scheduleRebuild + composed FunctionDispatchState)
- function-locator.ts (read-only narrow interface)
- function-dispatch.ts (chain stream + refute + futureDispatchContext)
- basic-block.ts (BasicBlock + buildCFG + extends NodeSet)

`framework/`:
- worklist.ts (driver, two-stream subscription primitives, monomorphic
  TransformRule sweep)
- analysis.ts (Analysis, AnalysisCtx, EntrySeed, Narrowing, TransformRule,
  TransformBindCtx)
- analysis-store.ts
- variant-body-clone.ts

Deleted in this run: view.ts, sweep-kind.ts, sweep-kind-polymorphism.test.ts.
Renamed: view-contract.test.ts → function-block-contract.test.ts.

The lifecycle-event vocabulary collapsed from five named events
(`onMint`/`onRebuildDirty`/`onRebuildEvict`/`onSpecRev`/`onRefute`) to two
delta primitives plus one orthogonal event (extent stream + chain stream +
refute).
