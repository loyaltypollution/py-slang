# Specialization framework — dissolve `View`, collapse the `on*` family, monomorphize again

This file is the forward-looking plan after Phases 0–13 (history in `progress.md`).
Where we ended up after Phase 13:

- `View` exists as an empty marker `interface View extends NodeSet {}`.
- `Function` and `BasicBlock` extend `View`.
- `FunctionManager` implements `FunctionLocator` and `SweepKind<Function>`.
- `Worklist` exposes `onMint` / `onRebuildDirty` / `onRebuildEvict` / `onSpecRev`.
- `TransformRule<V extends View, P>` and `SweepKind<V>` exist; the polymorphism is
  pinned by one synthetic test, but every real consumer is `Function`-shaped.

The diagnosis: we built the polymorphism story before having two consumers. `View`
is a noun that adds no methods. `SweepKind` has one implementer (`FunctionManager`).
`TransformRule<V, P>` is generic but every call site instantiates `<Function, FunctionLocator>`.
The `on*` family encodes one underlying delta as three named events.

## The corrected model

The worklist sees two streams over an opaque per-unit identity:

1. **Extent stream**: `(unit, prev: NodeSet, next: NodeSet)` — node-membership
   churn. Mint = prev empty. Rebuild = both non-empty. Retire = next empty.
   These collapse to one delta primitive — eviction listeners gate on
   `prev.size > 0`, replay listeners gate on `prev` being EMPTY_NODESET.
2. **Chain stream**: `(unit, prev: AssumptionChain, next: AssumptionChain)` —
   the unit's preferred future-dispatch chain changed.

`onRefute(unit, carrier)` is **not** part of these streams. It signals "a specific
assumption carrier was refuted"; consumers (memoization, dispatch reconciliation)
need the carrier identity, which a chain-delta over the unit's *preferred* chain
does not carry. It stays.

`Unit` is not introduced. The four-property bundle (NodeSet + identity +
replaceable body + chain) is a description of `Function` today, not a typeclass
needing a name. Future block- or trace-level OSR adds new stream producers and
new id types; the worklist's primitives don't have to bake in granularity.

`View` is deleted. The "exclude EMPTY/ANY/singleton from transforms" fence is
already enforced at the registration surface — no marker interface needed.

`SweepKind` is deleted. One consumer, no second consumer in sight; the right
shared shape will be extracted from two when the second arrives.

`TransformRule<V, P>` reverts to monomorphic `TransformRule` over `Function`.
The polymorphism cost type-system ceremony at every call site for a story that
no consumer paid for. Re-introducing it is mechanical when a second root-kind
appears.

## Phases

Each phase: tsc clean (baseline = 2 pre-existing parser errors in
`python-grammar.ts`), specialization tests green, one commit. `progress.md` gets
the per-phase entry.

### Phase 14 — delete `View`

- Delete `src/specialization/program/views/view.ts`.
- `Function` and `BasicBlock` directly `extends NodeSet`.
- Remove `View` imports from `worklist.ts`, `analysis.ts`, `sweep-kind.ts`
  (will be deleted in Phase 18 anyway), and the polymorphism test (deleted in
  Phase 19).

### Phase 15 — collapse the extent stream

- `FunctionManager`:
  - Replace `mintSubs` + `rebuildSubs` with one `extentSubs:
    Array<(unit, prev: NodeSet, next: NodeSet) => void>`.
  - Replace `onMint(cb)` + `onRebuild(cb)` with `onExtentChange(cb)`. Subscribe-
    time replay fires `(unit, EMPTY_NODESET, currentExtentSnapshot)` for every
    existing unit so late subscribers still get the burst.
  - `addFunction` fires `(unit, EMPTY_NODESET, currentSnapshot)`.
  - `flushPendingRebuilds` snapshots `prev` ids before `wireCFG`, fires
    `(unit, prevSnapshot, nextSnapshot)` after.
- A unit's "extent snapshot" is `nodeSetOfIds(new Set(unit.nodeToBlock.keys()))`.

### Phase 16 — collapse the chain stream

- `FunctionDispatchState`:
  - Rename `specRevSubs` → `chainChangeSubs`.
  - `onSpecRev(cb)` → `onChainChange(cb: (unit, prev, next) => void)`.
  - `fireSpecRev(unit)` → `fireChainChange(unit, prev, next)`.
- Worklist call sites at the two `fireSpecRev` invocations capture the prior
  chain (the value before `setFutureDispatchContext` / `clearFutureDispatchContext`)
  and pass `(unit, prev, next)` through.
- `onRefute(unit, carrier)` stays as is — separate semantic.

### Phase 17 — rewire Worklist + analyses

- Worklist:
  - Drop `onMint` / `onRebuildDirty` / `onRebuildEvict` / `onSpecRev`.
  - Add `onExtentChange<K extends NodeSet>(reader, dirtied)` and
    `onChainChange<K extends NodeSet>(reader, dirtied)`. Both forward to
    FunctionManager / FunctionDispatchState with prev/next.
- `dfa-factory.ts`:
  - `wl.onMint(envAnalysis, ...)` + `wl.onRebuildDirty(envAnalysis, ...)` →
    one `wl.onExtentChange(envAnalysis, (_loc, unit) => [seedKey(unit)])`.
  - `wl.onRebuildEvict(unit => evictStaleBlockCells(...))` becomes a side-effect
    inside the same listener gated on `prev.size > 0`. Either fold it into the
    extent listener or keep `onRebuildEvict` as a thin secondary entry that
    just installs an extent listener with that gate. (Pick the one that reads
    cleaner; lean toward folding.)
  - `wl.onSpecRev(...)` → `wl.onChainChange(...)`.
- `purity/analysis.ts`: same migration; three on-events collapse to one extent
  + one chain.

### Phase 18 — delete `SweepKind`, monomorphize `TransformRule`

- Delete `src/specialization/framework/sweep-kind.ts`.
- `FunctionManager` no longer `implements SweepKind<Function>`. Its `chainFor`
  and `scheduleRebuild` methods become plain methods on the manager (already
  named that way).
- `Worklist`:
  - `transformEntries: Map<rule, { kind, dirty }>` →
    `transformDirty: Map<rule, Set<Function>>` (back to the pre-Phase-11 shape).
  - `registerTransform` is single-arg. Single overload, no kind injection.
  - `sweepTransforms` calls `this.functionManager.chainFor(unit)` and
    `this.functionManager.scheduleRebuild(unit)` directly.
- `TransformRule<V, P>` → `TransformRule`. `sweep(unit: Function, chain, locator)`.
- `TransformBindCtx<V>` → `TransformBindCtx`. The on-events it exposes
  (`onTransformFactDirty`, `onTransformCounterBumped`, `onRefute`) are
  `Function`-shaped.

### Phase 19 — test cleanup

- Delete `src/tests/specialization/sweep-kind-polymorphism.test.ts` — pinned a
  generality the architecture no longer claims.
- Update `src/tests/specialization/view-contract.test.ts`: drop the `View`
  vocabulary; assertions about `BasicBlock.unit` stability and locator agreement
  stay, expressed against the new API.
- Run full specialization suite. Anything that fails because it was pinned to
  the old `on*` vocabulary gets rewritten or deleted. Don't bend the new shape
  to satisfy a test from the old shape.

## What survives this round

- `NodeSet` as the routing/dataflow primitive.
- `Function` as the current optimization/scheduling root, with `FunctionManager`
  as its concrete owner (lifecycle + locator + dispatch + sweep target rolled
  together — that's accurate, not a god object, because it's one role per
  surface).
- `BasicBlock` as a subordinate region owned by its function's CFG.
- `FunctionId` and `ParamKey` as boundary identities for runtime/JIT ingress.
- `AssumptionChain` and refutation as the speculation primitive.

## What this leaves open (deliberately)

- A second root view kind (Loop, Trace, Block-level OSR root). When it arrives:
  one new manager produces its own extent + chain streams; `Worklist`'s
  subscription primitives extend by overload, not refactor. `TransformRule`
  re-acquires generics from two consumers.
- Whether `Function` should split further. The current bundling is justified by
  there being one of each role per Function. Two roles per Function would
  trigger the split.
