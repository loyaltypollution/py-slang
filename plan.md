# Specialization framework — plan

History through Phase 19 lives in `progress.md`. This file is the forward
plan.

> **Status: Phases 20–27 complete.** What landed:
>
> - **20** plan.md rewritten around `NodeSet` / `Unit` / publication
>   separation; FunctionManager and JIT publish path audited.
> - **21** `UnitExtent` introduced; lifecycle streams now carry it
>   instead of arbitrary `NodeSet`.
> - **22** `UnitDomain<U, L>` and `UnitLocator<U>` defined;
>   `FunctionLocator extends UnitLocator<Function>`; `FunctionManager`
>   implements `UnitDomain<Function, FunctionLocator>`. Dead
>   `functionForAst` removed.
> - **23** `Worklist` injects `units: UnitDomain<Function,
>   FunctionLocator>` and routes generic lifecycle/scheduling through it.
> - **24** `TransformRule<U, L>` and `TransformBindCtx<U, L>` are generic
>   with defaults `(Function, FunctionLocator)`.
> - **25** Observation ingress (chain mutate / fire / refute) routes
>   through `UnitDomain` — no `functionManager.dispatch.*` references in
>   `worklist.ts` outside construction. EntrySeed doc names the unit's
>   reseed frontier.
> - **26** `specialization/publication.ts` names the boundary between
>   framework and execution layer; `PublicationGranularity` makes
>   today's `"per-call"` choice explicit.
> - **27** Synthetic non-`Function` `UnitDomain` test proves the contract
>   is satisfiable without `Function`.
>
> Test baseline: 47 suites / 2949 tests pass.
>
> The single remaining structural change is making `Worklist` itself
> parametric on `<U, L>` (today its `units` field is built from a
> `FunctionManager` in the constructor). The synthetic test of Phase 27
> is the contract that future change must preserve.

The point of the next round is to make the framework's real contracts explicit
before more specialization machinery lands.

Today three different concerns are still partially collapsed into one noun,
`Function`:

- **extent** — which nodes are we talking about?
- **speculation** — under which assumptions are we talking about them?
- **atomic replacement** — what stable thing do we rewrite, reschedule,
  recompile, and publish?

The first two already have good universal primitives:

- `NodeSet`
- `AssumptionChain`

The third one is still implicit. This plan makes it explicit and uses one noun
consistently for it:

- **Unit**

Today, `Function` is the only concrete `Unit`.

---

## Current shape

```
specialization/
  program/            ← node-set, slot-table, function*, basic-block
  framework/          ← worklist, analysis, analysis-store, variant-body-clone
  analysis/           ← per-DFA passes
  transforms/         ← AST sweeps gated on analyses
  observation/        ← runtime ingress (channels, counters, bindings)
  speculation/        ← chain dispatch + assumption-body utilities
  assumption/         ← AssumptionChain + refutation algebra
  narrowing-policy/   ← param-handles, entry-guards, ParamKey
```

After Phases 14-19:

- `View` is gone.
- `SweepKind` is gone.
- `TransformRule` is monomorphic over `Function` again.
- lifecycle is expressed as two delta streams plus one orthogonal event.

That simplification was good. The remaining problem is not `View`; it is that
`Function` still silently plays the role of the framework's atomic
specialization unit.

---

## Contracts recovered from current code

These are already true in the codebase. The plan should treat them as explicit
contracts, not accidents.

### 1. `NodeSet` is the universal extent / routing primitive

Analysis keys are `K extends NodeSet`. Advancing writes publish a
`delta: NodeSet`, and subscribers fire when `intersects(delta, interest)`.

This is the right abstraction for:

- analysis transfer keys,
- node-local subscriptions,
- block fact deltas,
- helper interests like singleton node ids and `ANY_NODESET`,
- structural subregions like blocks and future loops.

### 2. `AssumptionChain` is the universal speculation primitive

Every analysis triple runs under a chain. Reads may walk ancestor chains
(`readMinimal`, `readDeepest`). Refutation is the only chain-poisoning
primitive.

### 3. Lifecycle is already correctly expressed as primitive streams

The framework now has:

- **extent stream**: `(unit: Function, prev: NodeSet, next: NodeSet)`
- **chain stream**: `(unit: Function, prev: AssumptionChain, next: AssumptionChain)`
- **refute event**: `(unit: Function, carrier: AssumptionChain)`

This is better than `onMint` / `onRebuild` / `onSpecRev` wrappers because the
deltas are the real primitive.

### 4. A hidden `Unit` contract still exists

Even after deleting `View`, the code still depends on a privileged program
entity with all of these responsibilities:

- stable identity across extent change,
- ownership of extent changes,
- ownership of a preferred future-dispatch chain,
- ownership of observation ingress,
- rebuild scheduling and flush,
- transform sweep granularity,
- compile / publish granularity.

Today that entity is `Function`.

### 5. Publish is function-atomic today

The current SVML JIT path is even more permissive than a slot-patch model:
each CALL re-derives the body under a live-correct chain and recompiles a
fresh `SVMLIR` (`PySvmlJitEvaluator.dispatchCall` →
`compiler.compileFunction(unit, body)`). The frame captures that IR direct;
nothing is stored back into `SVMLProgram`. `SVMLInterpreter.patchFunction`
exists as a dormant hook for future slot-patching but has no production
caller.

Either way the granularity is the same — one `Function` — and the visibility
guarantees match:

- current frames keep executing the IR they already captured,
- only future dispatch sees a recompiled body,
- publication is only required to be safe at function-call boundaries.

That is the current no-OSR contract. This is not merely an engine detail; it
explains why the current architecture can avoid OSR.

### 6. Audit of `FunctionManager` responsibilities

For a future `UnitDomain` implementer, here is the concrete embodiment of each
`Unit` responsibility today:

| Responsibility            | `FunctionManager` surface |
|---------------------------|---------------------------|
| identity / registry       | `functionsByFunctionId`, `functionByNode`, private `registerUnit`/`indexUnitNodes` |
| iteration                 | `values()` |
| extent ownership          | private `snapshotExtent`, `onExtentChange` (with subscribe-time replay), `addFunction` (mint fan-out), `flushPendingRebuilds` (rebuild fan-out) |
| rebuild scheduling        | `scheduleRebuild`, `pendingRebuilds`, `hasPendingRebuilds`, `flushPendingRebuilds` |
| locator (program-shape)   | `functionById`, `functionForAst`, `functionContainingNode`, `blockContaining` |
| chain ownership           | composed `dispatch: FunctionDispatchState` — owns `futureDispatchContextByUnit`, `onChainChange`, `setFutureDispatchContext`, `clearFutureDispatchContext`, `fireChainChange` |
| refutation handling       | `dispatch.onRefute`, `dispatch.fireRefuteAndReconcile` |
| node→chain shortcut       | `futureDispatchChainForNode` (composes `functionContainingNode` + `chainFor`) |

### 7. Locator queries — generic vs. consumer-specific

Not every locator method is needed by generic framework code. The split:

- `functionContainingNode` — **generic**. Used by the worklist itself
  (`defaultUnitResolver`, `futureDispatchChainForNode`). The minimum
  `UnitLocator<U>` surface should be exactly `unitContainingNode(nodeId)`.
- `functionById` — **consumer-specific**. Only analyses, transforms, and
  observation use it (`param-handles`, `type-requirement`, `purity`,
  `memoization`, `runtime-analyses`, `jit-dispatch`).
- `blockContaining` — **consumer-specific**. Only `dfa-factory` reads it.
- `functionForAst` — **dead in production code**. Candidate for removal once
  the locator split lands.

This is what makes the Phase 22 split tractable: only one method has to
graduate to the generic interface; the rest stay on a concrete
`FunctionLocator extends UnitLocator<Function>`.

---

## Unified vocabulary

This plan should use one central noun consistently.

### `NodeSet`
The universal set-of-nodes abstraction.

Use it for:

- analysis keys,
- write deltas,
- routing interests,
- structural subregions.

### `AssumptionChain`
The universal speculation abstraction.

### `Unit`
A stable atomic specialization entity.

A `Unit` is the thing that owns:

- extent change,
- preferred dispatch chain,
- refutation handling,
- rebuild scheduling,
- transform sweep,
- compile / publish policy.

Today, `Function` is the only concrete `Unit`.

### `UnitExtent`
A stronger contract than arbitrary `NodeSet`.

A `UnitExtent` is:

- finite,
- enumerable,
- immutable for the duration of the event / consumer action,
- suitable for eviction and retirement logic.

Proposed shape:

```ts
interface UnitExtent extends NodeSet {
  readonly size: number;
  iterate(): Iterable<NodeId>;
}
```

This matters because arbitrary `NodeSet` is intentionally weak. That is correct
for routing interests, but too weak for lifecycle snapshots.

### `UnitLocator<U>`
The minimal program-shape lookup surface needed by generic framework pieces.

Minimum target:

```ts
interface UnitLocator<U> {
  unitContainingNode(nodeId: NodeId): U | undefined;
}
```

Concrete locators may expose more. The current function locator also needs
function-specific queries like `functionById`, `functionForAst`, and
`blockContaining`.

### `UnitDomain<U, L>`
The generic lifecycle/speculation/scheduling contract for one unit kind.

Target shape:

```ts
interface UnitDomain<U, L extends UnitLocator<U>> {
  readonly locator: L;

  values(): Iterable<U>;

  extentOf(unit: U): UnitExtent;
  onExtentChange(cb: (unit: U, prev: UnitExtent, next: UnitExtent) => void): void;

  chainFor(unit: U): AssumptionChain;
  onChainChange(cb: (unit: U, prev: AssumptionChain, next: AssumptionChain) => void): void;

  onRefute(cb: (unit: U, carrier: AssumptionChain) => void): void;

  scheduleRebuild(unit: U): void;
  flushPendingRebuilds(): readonly U[];
}
```

`FunctionManager` should become the first implementation of this contract.

### publication contract
This does not need to be a new framework type immediately, but it must be named
explicitly.

Questions this contract answers:

- what do we compile when a unit changes?
- what artifact do we patch atomically?
- when does executing code see the replacement?
- what safe points exist?
- when is OSR required rather than optional?

Today the answer is: **compile and patch at function granularity; only future
calls see the result**.

---

## Core separation to preserve

The main conceptual correction is:

> a `Unit` is not just a `NodeSet`

Correct model:

- `NodeSet` answers: **which nodes?**
- `Unit` answers: **which stable specialization entity owns those nodes,
  chain semantics, rebuild policy, and publication policy?**
- `UnitExtent` answers: **what was that unit's concrete extent at this moment?**

Consequences:

- `NodeSet` should replace `View`.
- `NodeSet` should **not** absorb the `Unit` contract.
- lifecycle streams should expose `UnitExtent`, not arbitrary `NodeSet`.

If `Function` continues to `extends NodeSet` for convenience in the short term,
that should be treated as an implementation detail, not the theoretical end
state.

---

## What the worklist should actually know

The worklist should be generic over one `UnitDomain`, not over arbitrary views
and not directly over `FunctionManager`.

### Responsibilities that stay generic

These remain unit-agnostic:

- analysis queueing and dedup,
- read-edge tracking,
- `NodeSet`-based delta routing,
- chain-walking reads,
- transform sweep orchestration,
- observation ingress ordering / fixpoint sequencing,
- rebuild / drain loop shape.

### Responsibilities that should route through `UnitDomain`

These are unit-specific and should move behind the domain contract:

- initial unit replay,
- extent change replay,
- chain change replay,
- refute fan-out,
- `chainFor(unit)`,
- `scheduleRebuild(unit)`,
- `flushPendingRebuilds()`,
- node → owning unit lookup used for future-dispatch queries.

### The worklist should not decide publication policy

The worklist can coordinate analysis / transform / rebuild convergence, but it
should not hardcode what compiled artifact gets patched or whether publication
requires OSR. That belongs to the publication contract / execution layer.

---

## Transforms: polymorphic over units, not arbitrary regions

The old `View`/`SweepKind` generality was too broad. The current
`Function`-only transform rule is too narrow.

The right abstraction is:

- transforms sweep over **units**,
- not over arbitrary `NodeSet`s,
- not over marker interfaces.

Target shape:

```ts
interface TransformRule<U, L> {
  sweep(unit: U, chain: AssumptionChain, locator: L): boolean;
  bind?(ctx: TransformBindCtx<U, L>): void;
}
```

`TransformBindCtx` should be parameterized the same way so fact and counter
dirtying wake the correct units without `Function`-specific knowledge baked
into the framework.

Blocks, loops, and other subregions remain plain `NodeSet`s unless and until
they are promoted to true units.

---

## Observation ingress must stay unit-resolved

Observation ingress is where the framework decides which unit's preferred
future-dispatch policy is being revised.

The plan should preserve these rules:

- every observation source resolves to an owning unit,
- all bindings sharing a source agree on that resolution policy,
- chain revision and refutation happen against that unit,
- reseeding after chain change starts from that unit's entry frontier.

Today this frontier is implicitly "function entry CFG block". If a future unit
kind has a different frontier, that difference belongs in the unit-domain
contract or an associated frontier policy — not in ad hoc worklist branches.

---

## Explicit publication / visibility contract

This must be written down before further implementation work.

### Current contract

- specialization mutates source AST / CFG state,
- rebuild recomputes function CFG materialization,
- recompilation builds a fresh function artifact,
- publication patches the function slot atomically,
- already-executing frames continue on the old IR,
- only future dispatch uses the new artifact.

This is the current no-OSR guarantee.

### Why this matters

If future work wants block-level or node-level replacement, the framework must
separate two questions that currently coincide:

1. **What unit do we analyze / transform / reschedule?**
2. **What artifact do we publish, and at what safe point?**

Possible futures include:

- block-level units but function-level publication,
- block-level publication with explicit safe points,
- trace-level units with trace publication,
- node-local transforms that still republish whole functions.

Those are different designs. The plan should keep them separate.

---

## When does a subregion become a unit?

This is the right future-facing question.

### A subordinate region
A loop / block / node remains just a `NodeSet` if:

- it is useful for routing or local reasoning,
- it is derived from some owning unit,
- its invalidation is completely explained by owning-unit extent change,
- it does not own distinct chain / rebuild / publication semantics.

### A true unit kind
A loop / block / trace / node becomes a unit only if it owns all of:

- stable identity,
- `UnitExtent` snapshots,
- preferred chain semantics,
- rebuild scheduling,
- observation ownership,
- an entry frontier for reseeding after chain change,
- a publication story.

Only then should the framework grow another `UnitDomain` implementation.

---

## Why extent / chain / refute are still the right primitive events

This should stay firm in the plan.

### Do not bring back `onMint` / `onRebuild` / `onRetire` as primary APIs

Those are derived classifiers over extent deltas:

- mint    ↔ `prev.size === 0 && next.size > 0`
- rebuild ↔ `prev.size > 0 && next.size > 0`
- retire  ↔ `next.size === 0`

The extent delta is strictly more informative than any one named wrapper.

So the primitive API should remain the delta stream. Local helpers are fine;
framework-level wrappers should not be the fundamental vocabulary again.

### Keep refute orthogonal to chain change

Refutation preserves the identity of the specific carrier that was invalidated.
That is not the same thing as a unit's preferred chain changing. Consumers like
memoization need the carrier identity, so `onRefute(unit, carrier)` stays
separate.

---

## Concrete target for this round

The first real end-state after this round should be:

- `NodeSet` remains the universal extent/routing primitive.
- `UnitExtent` is introduced and used on lifecycle streams.
- `Function` remains the only concrete unit kind, but now as an explicit
  implementation of a generic `UnitDomain` contract.
- `Worklist` depends on `UnitDomain<Function, FunctionLocator>` rather than on
  `FunctionManager` directly.
- `TransformRule` is generic over units again, specifically in the sense of
  **unit polymorphism**, not arbitrary region polymorphism.
- publication remains function-atomic until a separate publication / safe-point
  design changes that.

That gets the theory right now without pretending block-level OSR is already
implemented.

---

## Proposed phase plan

### Phase 20 — lock the contracts in docs

Deliverables:

- this `plan.md` rewritten around `NodeSet` / `Unit` / publication separation,
- terminology settled (`Unit`, `UnitExtent`, `UnitDomain`, publication
  contract),
- explicit statement of current no-OSR visibility guarantees.

Acceptance:

- a future implementer can answer "what is special about `Function` today?"
  from the doc alone.

### Phase 21 — introduce `UnitExtent`

Deliverables:

- add the stronger lifecycle snapshot type,
- change extent streams from `(prev: NodeSet, next: NodeSet)` to
  `(prev: UnitExtent, next: UnitExtent)`,
- keep arbitrary `NodeSet` everywhere else.

Acceptance:

- lifecycle listeners can rely on finite enumeration without optionality,
- routing/helper `NodeSet`s remain weak and cheap.

### Phase 22 — introduce `UnitDomain` / `UnitLocator`

Deliverables:

- define the generic unit-domain interfaces,
- make `FunctionManager` implement them,
- rename function-only helper types where needed so they stop pretending to be
  universal.

Acceptance:

- the function implementation is the first instance of an explicit generic
  contract, not the source of the contract.

### Phase 23 — make `Worklist` depend on a unit domain

Deliverables:

- parameterize or otherwise inject the unit domain into `Worklist`,
- remove direct `FunctionManager` assumptions from generic worklist internals,
- keep `worklist.locate` only as a convenience surface over the domain's
  locator.

Acceptance:

- generic worklist code routes lifecycle/speculation through the domain
  contract rather than through concrete function-manager methods.

### Phase 24 — make transforms unit-polymorphic again

Deliverables:

- restore generic `TransformRule<U, L>` and `TransformBindCtx<U, L>`,
- make transform dirty sets keyed by the worklist's unit type,
- ensure transform sweep gets chain and rebuild scheduling through the unit
  domain.

Acceptance:

- transform polymorphism is about unit kinds, not arbitrary regions.

### Phase 25 — genericize observation-unit resolution

Deliverables:

- formalize per-source unit resolution as part of the worklist/domain
  contract,
- ensure chain change / refute / reseeding use the unit abstraction rather
  than `Function` directly,
- document the reseed frontier as part of the unit design.

Acceptance:

- every observation source is explicitly tied to an owning unit policy.

### Phase 26 — extract the publication contract

Deliverables:

- write down the interface between specialization and execution/JIT layers,
- explicitly name current artifact granularity and visibility semantics,
- separate "unit changed" from "what compiled artifact gets patched".

Acceptance:

- the codebase has one clear place to hang future OSR or smaller-granularity
  publication work.

### Phase 27 — add synthetic non-function unit tests

Deliverables:

- tests proving worklist orchestration is genuinely unit-domain based,
- synthetic unit domain that is not `Function` but can drive extent replay,
  chain replay, transform dirtying, and rebuild scheduling.

Acceptance:

- genericity is proven by code, not just comments.

### Phase 28+ — only then consider real new unit kinds

Candidates:

- loop units,
- block units,
- trace units,
- node units.

Each candidate must answer the unit checklist before entering the framework.

---

## Unit-kind checklist

Before introducing any non-function unit kind, answer all of these explicitly.
If any remain unanswered, the candidate stays a subordinate `NodeSet`, not a
unit.

1. **Identity** — what is the stable key for one unit instance?
2. **Extent** — how is its `UnitExtent` computed and updated?
3. **Locator** — how do we map node ids / boundary ids to the owning unit?
4. **Frontier** — where do chain-change reseeds begin?
5. **Observation ownership** — which runtime events revise this unit's chain?
6. **Rebuild** — what does scheduling and flush actually rebuild?
7. **Artifact** — what compiled artifact corresponds to the unit?
8. **Publication** — when does executing code observe the new artifact?
9. **OSR** — if current frames may observe the change, what safe-point story
   makes that correct?
10. **Retirement** — what state is evicted or invalidated when `next` becomes
    empty?

---

## Validation / tests to pin during the refactor

### UnitExtent invariants

- extent snapshots are enumerable and finite,
- subscribe-time replay uses an empty previous extent and a concrete next
  extent,
- rebuild emits non-empty previous and next extents,
- retirement, when introduced, emits non-empty previous and empty next.

### Unit-domain invariants

- worklist transform sweep routes through the unit domain rather than directly
  through `FunctionManager`,
- chain changes are observed through the unit-domain stream,
- refute remains orthogonal to chain change,
- future-dispatch-by-node is derived from `unitContainingNode(nodeId)` plus
  `chainFor(unit)`.

### Publication invariants

- current no-OSR behavior remains pinned: current frames do not see mid-frame
  publication,
- future dispatch does see the new artifact,
- publication granularity is documented and tested independently from analysis
  dirtiness granularity.

### Synthetic genericity test

- a synthetic non-function unit domain can drive worklist lifecycle and
  transform sweep without function-specific code paths.

---

## Non-goals

- Do **not** reintroduce `View` as a marker interface. `NodeSet` is the extent
  language.
- Do **not** make transforms polymorphic over arbitrary structural regions.
  Unit polymorphism is the goal.
- Do **not** let `NodeSet` silently absorb the `Unit` contract.
- Do **not** re-expand primitive delta streams back into named lifecycle
  wrappers.
- Do **not** claim block/node/trace publication is solved merely because the
  worklist becomes unit-generic.
- Do **not** leave publication / visibility semantics implicit in JIT code.

---

## Summary

The intended architectural picture is:

- `NodeSet` answers: **which nodes?**
- `AssumptionChain` answers: **under which speculative assumptions?**
- `UnitDomain` answers: **which stable specialization unit owns extent,
  chain, refutation, and rebuild policy?**
- the publication contract answers: **what compiled thing changes, and when can
  executing code observe the change?**

Today, `Function` is the answer to the third and fourth questions. That is a
valid current implementation choice. The next round should make that choice
explicit, generic, and separately replaceable.
