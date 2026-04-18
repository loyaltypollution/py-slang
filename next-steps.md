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

Tests: `npx tsc --noEmit && npx jest` — 2663 green.

---

## What's still open

Three pieces from the original thesis remain. They're independent — pick by
value, not serial order.

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

### (2) Must-backward quadrant

Propagates "return kind = int" backward through the body to find assignments
that contradict the speculation, placing the guard at the function entry.
Orthogonal to the artifact tree; depends only on contexts existing.
Classical DFA quadrant currently missing; arguably the highest per-PR value.

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
