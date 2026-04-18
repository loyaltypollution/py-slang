# DFA Framework: Status & Open Work

This file started as a pre-implementation thesis. The thesis held up; most of
it has landed. This revision keeps only what a future reader still needs:
the goal to measure against, what's shipped, what's still open, and the
constraints that remain binding.

---

## The goal (reference bar)

**Speculation and recovery should live in the specialization engine, not be
scattered across analyses.**

Any analysis X should be able to run under a set of *assumptions* — "x at
node 17 is int", "branch B always takes the true arm" — and produce facts
consistent with those assumptions. When an assumption is later invalidated
at runtime, the specialization engine recovers: it swaps to a compiled
version that didn't depend on the violated assumption, while transforms
derived from *unrelated* assumptions stay intact.

The old model tangled speculation into individual analyses (parallel
`speculativeX`/`X` pairs, special accumulation modes, ad-hoc eviction). The
refactor pulls it out: analyses compute facts under a context; the engine
owns context creation, composition, and recovery.

Use this as the bar. If a surface reads fine but its production path
collapses to a whole-unit reset (ROOT), unrelated assumptions are being
thrown away and the goal isn't being met — regardless of what the API
looks like in isolation.

---

## Where we are

The speculation refactor is substantially complete. Speculation is now a
context under which an analysis runs, not a property of the fact:

- **`Context`** is a tree of assumptions with navigational operations only.
  `src/specialization/framework/context.ts`.
- **Fact cells** are keyed by `(analysis, key, context)`; each cell runs
  independent monotone Kildall. `src/specialization/framework/fact-store.ts`.
- **Transforms** accept only `StaticDfaQuery` — the type-level gate that
  makes a transform reading a speculative fact unrepresentable.
  `src/specialization/dfa-query.ts`, enforced in
  `src/tests/specialization/framework/dfa-query-gate.test.ts`.
- **Speculation policy** is pluggable via `SpeculationStrategy`; the built-in
  `countBasedStrategy(N)` ships as one concrete policy.
  `src/specialization/framework/speculation-strategy.ts`.
- **Narrowing dimensions** are data-driven through the `Narrowing<V>`
  interface. The worklist iterates `DEFAULT_NARROWINGS` in the observation
  translator, `widenGuard`, `widenFullChain`, and `lineageOf`. Adding
  a third dimension is a one-line registration in
  `src/specialization/framework/dfa-analyses.ts`.
- **Deopt** is lineage-precise *for node-keyed narrowings* (type, const).
  Backends publish guard provenance via `Worklist.registerGuard`; on
  `SpeculationViolation`, `widenGuard(nodeId)` prunes only the load-
  bearing assumptions. Missing provenance now throws (used to silently
  collapse to ROOT — see (4) in "What's still open"). The
  `specContextChange` lifecycle event wakes jit-keyed analyses; evaluators
  use the shared `runWithDeopt` helper (`src/conductor/jit-deopt.ts`).
- **Must-backward quadrant** ships as `typeRequirementAnalysis`
  (`src/specialization/type-requirement-analysis/analysis.ts`). Runs
  backward under a return-kind assumption bound via
  `returnKindNarrowing`; seeds at each `Return` statement and produces a
  per-slot entry requirement. `requirementAtEntry` returns a split
  `{ provable, unprovable }` — provable slots are guard candidates,
  unprovable slots signal "speculation can't hold for any input."

Tests: `npx tsc --noEmit && npx jest` — 2695 green.

---

## What's still open

The thesis pieces (1), (3), (4) remain; (2) — the must-backward DFA
itself — has shipped. The backlog now splits into: one thesis-level item
(artifact tree), one orthogonal fix (`resolveBlock`), and a consumer
cluster that turns must-backward facts into emitted guards and IR.

### (1) Artifact tree per `(unit, context)`

Currently the JIT stores one IR per unit (`jit-analysis.ts`). A context
shift invalidates the snapshot and triggers a recompile; there is no
pre-built sibling version ready to swap to.

The thesis target: per `FunctionUnit`, a tree of compiled IRs each tagged
with its context; runtime picks the deepest live version; deopt swaps to
the parent instead of recompiling.

**Engine surface (backend-agnostic):**
- `Map<(unit, context), IR>` fact store, or equivalent.
- Hook: `onActiveContextChange(unit, context)` that a backend subscribes to
  when it owns the dispatch mechanism.

**Backend-specific:** how a running program routes a call to the currently-
active version, and how a guard failure transfers control upward. SVML does
this via the function table + guard opcodes; a future WASM backend would do
it via multiple exports + a trampoline. The engine stays uniform.

**Prerequisite for true sibling coexistence:** canonical sibling contexts.
Today `handleObservationForSpec` stacks observations linearly
(`Root → A → B`, not `{Root→A, Root→B}`). Lineage-precise widen is already
precise either way, so this only matters when we want multiple compiled
versions per unit to live side-by-side.

### (2) Must-backward consumers

The DFA ships; nothing yet reads its facts at codegen time. Consumers
below are independent — pick by value. All are backend-touching except
where noted.

- **Entry-guard emission.** The primary consumer. At compile-unit start,
  call `requirementAtEntry(factStore, unit, specContextFor(unit))`; for
  each slot in `provable`, emit a parameter kind-check and
  `registerGuard(entryNodeId, { narrowing: returnKindNarrowing, key: fdId })`.
  Slots in `unprovable` mean the speculation is statically impossible —
  skip emission. Blocked on (4): until `resolveBlock` lands, deopt
  through an entry guard collapses to `widenFullChain` instead of
  pruning just the return-kind assumption.
- **Guard coalescing.** Multiple forward-emitted guards on the same
  `(slot, requiredType)` collapse to one at a dominating merge point if
  the backward fact at that block already says "required." Needs a CFG
  dominator pass (not yet present — confirm before picking up). Backend
  IR-pass territory, not a `TransformRule`.
- **Redundant-guard elimination.** Co-located with guard emission:
  before emitting, query forward `typeAnalysis` and backward
  `typeRequirementAnalysis` at the site's block; skip when
  `forward ⊑ requirement`. Lives in the backend path — the
  `StaticDfaQuery` gate forbids speculative reads from `TransformRule`s.
- **Dead-branch under backward facts.** `dead-branch.ts` today reads
  forward only. Backward adds cases like `if x == "foo"` under
  `x: INT_BIT required`. Design gate first: widen `StaticDfaQuery` to
  allow invariant-preserving reads, or move this logic into the backend.
- **Transfer coverage, sign axis.** Current propagator is kind-axis only
  (`int ⊗ int = int` for `+`, `-`, `*`, `//`, `%`; ternary). Sign-axis
  inverses (e.g. `pos * pos = pos`) are deferred. Worth it once a guard
  consumer can exploit tighter-than-kind refinements.
- **Strategy access to must-backward facts.** An earlier iteration
  added `ObservationEvent.requirementsAt()` as a stability hint for
  strategies, then removed it as premature — no concrete strategy used
  it. When a strategy genuinely wants to read backward facts before
  deciding to extend, land the accessor and the consuming strategy in
  the same PR so the surface earns its keep.
- **Runtime integration test.** Mirror `speculative-narrowing.test.ts`'s
  "lineage-precise widen" through `observeRuntimeReturn`: observe int
  return ×N → entry guard emitted → observe str once → widenGuard →
  guard retracted, body re-runs unspeculated. Blocked on entry-guard
  emission.

### (3) Canonical sibling contexts

See (1). Not a blocker on its own — present here for the backlog.

### (4) `resolveBlock` hook on `Narrowing` (lineage-precise return-kind deopt)

`lineageOf` seeds its per-link Kildall re-run by calling
`unit.blockOfNode.get(ref.key)`. That works for node-keyed narrowings
(`typeExprHandle`, `constExprHandle`) but not for `returnKindHandle`, whose
`key` is an fdId. `blockOfNode.get(fdId)` returns `undefined`, `lineageOf`
bails with `[]`, and `widenGuard` falls through to `widenFullChain` — sound,
but every return-kind deopt collapses the whole chain instead of pruning
just the return-kind assumption.

Fix: generalize `Narrowing<V>` with a `resolveBlock(unit, key): BasicBlock |
undefined` hook. Node-keyed narrowings implement it as
`unit.blockOfNode.get(key)`; return-kind resolves to the function's exit
block (or whatever block the narrowing's `blockAnalysis()` seeds). Small
interface change, unblocks the "sibling survives" guarantee for the
return-kind dimension the rest of the doc claims. No other piece of the
framework depends on this — orthogonal PR.

---

## Non-negotiable constraints

Still binding:

1. **No new `speculativeX` analyses.** Same-analysis-under-context is the
   pattern.
2. **No overwrite-mode fact cells.** The knob was deleted; reintroducing it
   is a regression.
3. **Any PR that grows `Context` surface must route a non-`∅` context
   through at least one caller.**
4. **Backends emitting guards must call `registerGuard` at emission.**
   `widenGuard` throws on missing provenance; there is no silent fallback.
   A new backend that emits guards without registering them will surface
   the bug on the first deopt, not by mysteriously collapsing unrelated
   assumptions.

---

## Cold-start reading

`src/specialization/framework/worklist.ts` front-to-back. Every cross-cutting
concern (context, strategy, provenance, observation translation, guard
widening) lives there; the rest of the framework is smaller and becomes
obvious after. `src/tests/specialization/runtime/speculative-narrowing.test.ts`
is the integration test that exercises the full pipeline; the
`lineage-precise widen` case is the best single test for understanding the
current contract.
