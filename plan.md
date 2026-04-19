# Plan: function-level speculative specialization via `Context`

## Status (implemented)

The v1 lane described here is now wired end-to-end for SVML, and the minimal
v2 helper surface has been added:

- direct function-entry parameter observations extend `Context` via param-scoped
  assumptions;
- `entryGuardsFor(unit, context)` projects direct param guards plus the existing
  return-kind-derived entry requirements;
- `specializedBodyFor(unit, context)` produces a compilation-only cloned body
  for entry-specializable param-const contexts;
- `guardKeyFor(unit, context)` provides canonical projected-guard equivalence
  for consumers that care about the entry-guard boundary rather than raw
  `Context` identity;
- `hasSpecializedBody(unit, context, topology)` lets a consumer ask whether the
  speculative cloned-body lane is applicable without taking ownership of the
  clone itself;
- `svml-jit-analysis.ts` compiles that cloned body in parallel with the
  existing backend path and emits direct entry guards before the specialized
  body executes;
- shared AST remains untouched; ROOT transforms remain ROOT-only.

What remains intentionally deferred:

- broader projected-guard equivalence / cache-key abstraction;
- clone-local analyses or fresh-`NodeId` remapping;
- backend cleanup that deletes the older SVML-only speculative path.

## Goal

Add a specialization-engine path for **function-level speculative specialization**
driven by entry-checkable parameter assumptions, while reusing the existing
`Context` mechanism.

This plan intentionally focuses on **specialization-engine-specific** changes.
Interpreter/runtime hotswap safety is assumed as an existing backend contract:
future dispatch may change, active frames stay on the old version.

---

## Non-goals for v1

- no OSR
- no mid-function guards
- no per-site speculative AST wrapping
- no speculative rewrites on shared AST
- no nested-function structural specialization
- no speculative assumptions derived from interior locals / intermediate values
- no attempt to make ordinary `TransformRule` consume non-ROOT facts

---

## Core model

Important scoping note:

- The current SVML JIT path already has substantial `(Unit, Context)` machinery:
  per-context caching in `src/conductor/svml-jit-analysis.ts`,
  `findReusableEntry(...)` cross-context reuse, `specContextChange` wakeups,
  prune-driven reselection, and `JIT_RELEVANT_NARROWINGS` as the backend's
  current "entry-specializable enough to matter" subset.
- This plan is **not** proposing to invent all of that again.
- The genuinely new v1 work is mainly:
  1. a backend-neutral **cloned speculative body** lane;
  2. speculative rewrite passes operating on that clone; and
  3. lifting/factorizing the already-existing SVML-specific context/version
     logic into a clearer specialization-engine contract where useful.

For each `Unit`:

- ROOT still owns the shared canonical AST and ordinary transform pipeline.
- Non-ROOT `Context` may justify a specialized **compilation artifact**.
- That artifact is derived only from **entry assumptions on parameters**.
- In v1 the artifact is a cloned specialized body that a backend may compile;
  the evaluator may still cache compiled IR per `(Unit, Context)` using its
  existing machinery.
- `Context` remains the provenance key for deciding when specialization is
  applicable.

Key boundary:

> Speculation does not mutate shared program structure. It derives
> context-scoped compilation inputs from it.

---

## Why reuse `Context`

Reasons:

1. fewer new nouns / interfaces;
2. existing ancestry and pruning semantics already fit version fallback;
3. future expansion toward broader speculation remains possible;
4. existing worklist / narrowing machinery already speaks `Context`.

Restriction for v1:

> Only `Context` assumptions that are checkable at function entry are allowed to
> justify speculative specialization.

That means `Context` stays general, but this pipeline consumes only an
entry-guardable subset.

---

## Required new distinction

The engine currently separates:

- ROOT-safe permanent transforms
- speculative guarded backend artifacts

We add a third lane:

- **entry-guarded speculative specialization**: per-`Unit`, per-`Context`,
  non-shared specialized bodies/artifacts

This should be a separate concept, not an overload of `TransformRule`.

---

## High-level pipeline

1. Runtime emits parameter observations.
2. Existing narrowing machinery extends a `Unit`'s active `Context`.
3. When the active `Context` for a `Unit` becomes entry-specializable, the
   specialization engine may derive entry guards and build a specialized body
   for that `(Unit, Context)`.
4. Backend/evaluator code may compile, cache, and publish artifacts derived
   from that specialized body for future calls.
5. If later observations invalidate that assumption lineage, `Context` prunes to
   an ancestor and future dispatch falls back accordingly.

The specialization-engine concern is therefore:

- deciding which `Context`s are eligible;
- deriving entry guards from them;
- producing the specialized body;
- documenting how evaluator-owned caches should treat `Context` ancestry.

---

## v1 speculation surface

Allowed speculative evidence:

- observed parameter kind/type
- optionally observed small scalar parameter constants

Not allowed in v1:

- observations about interior locals
- path-local expression facts
- return-kind-driven interior rewrites unless re-expressed as entry assumptions
- arbitrary runtime profiler evidence as semantic rewrite justification

Rule:

> If a fact cannot be checked cheaply and fully at function entry, it does not
> justify speculative specialization in v1.

---

## Engine changes

## 1. Introduce entry-specializable narrowing subset

Define an explicit subset of existing narrowings/assumption handles that are
legal inputs to speculative specialization.

Desired property:

- every allowed assumption maps to a concrete parameter-entry guard shape.

Possible shape:

- a small helper near `src/specialization/framework/dfa-analyses.ts` or in a new
  engine-facing module that answers:
  - is this narrowing entry-guardable?
  - how does `(handle, key, value)` map to a parameter guard?

Deliverable:

- one canonical registry/list of entry-specializable assumption kinds
- tests rejecting non-entry-guardable assumptions from this pipeline

---

## 2. Reuse evaluator-owned `(Unit, Context)` caching; do not abstract it yet

This is mostly a **reuse/document/factor** step, not a greenfield mechanism.

What already exists today in `src/conductor/svml-jit-analysis.ts`:

- per-`(Unit, Context)` storage via `WeakMap<Unit, Map<Context, CacheEntry>>`
- reuse/fallback via `findReusableEntry(...)`
- prune/reselect via `specContextChange`

The new specialization lane should plug into that existing shape rather than
introducing a new public versioning abstraction in v1.

Deliverable:

- document that evaluator-owned caches remain the owner of compiled artifact
  lifecycle in v1
- no reuse of `TransformRule` for this purpose
- no new public version-manager/store abstraction unless a second consumer
  proves it necessary

---

## 3. Add entry-guard derivation from `Context`

Given a `(Unit, Context)`, derive the entry guard set that must hold for that
specialized body to be valid.

This requires walking `Context` ancestry and selecting only assumptions relevant
to that `Unit`'s parameters.

Responsibilities:

- ignore assumptions not mappable to parameter-entry checks
- produce canonicalized guard sets
- preserve ancestor fallback semantics

Important invariant:

> Guard derivation is a pure projection from `Context` to entry-checkable
> assumptions; it does not invent new speculative facts.

Deliverable:

- helper such as `entryGuardsFor(unit, context)`
- tests for ancestor/child contexts producing expected guard subsets

---

## 4. Add speculative PyAST clone + rewrite lane

Create a specialization-engine path that:

- clones the function AST for a `Unit`
- applies a restricted set of speculative rewrites justified by the derived
  entry guard set
- never mutates shared AST

### NodeId policy — decide before implementation

This is load-bearing because block-DFA facts are keyed by original `NodeId`.

Chosen v1 direction: **Option A**.

- The speculative clone is an artifact/shadow body for compilation input.
- Cloned nodes preserve the original `NodeId` values as stable references back
  to the canonical unit's analysis namespace.
- The clone is **never** inserted into the analysis store, CFG, topology, or
  any framework structure that treats `NodeId` as owning mutable program
  identity.
- All semantic/speculative facts are still read from the original unit's
  analyses using the original `NodeId` namespace.

Why this choice:

- it matches the current JIT shape, which compiles from `unit.funcAst` while
  reading facts from the canonical analysis world;
- it avoids fresh-`NodeId` remapping infrastructure in v1;
- it keeps the clone as a compilation artifact, not a second analyzed program.

Deferred option:

- fresh `NodeId`s plus an alias/remap table is explicitly out-of-scope for v1;
  revisit only if later rewrite families need clone-local analyses.

This is the main reusable lane for both CSE and SVML.

Restrictions on rewrites in v1:

- function-local only
- justified entirely by entry assumptions
- no add/remove function definitions
- no reliance on mid-function guard points

Good first rewrite families:

- dead branch pruning from parameter constant assumptions
- numeric operator specialization from parameter kind assumptions
- simplifications already expressible as ordinary transforms if their
  precondition were known at ROOT

Implementation note:

- do **not** retrofit ordinary root transforms to read non-ROOT facts
- instead, create a small separate speculative rewrite pass surface over the
  cloned function body

Deliverable:

- cloned-body builder
- 1-2 speculative rewrite passes
- tests proving shared AST is unchanged

---

## 5. Document cache invalidation / fallback by `Context` ancestry

This is again mostly a **reuse/document/factor** step, not wholly new runtime
machinery.

Today, `src/conductor/svml-jit-analysis.ts` already provides:

- per-context artifact retention,
- prune-triggered reselection,
- cross-context reuse via semantic snapshot comparison.

The plan's new requirement is narrower: make that policy explicit for the new
cloned-body lane, and decide whether evaluator-owned caches should prefer exact
`Context` hits only or the current broader "semantically reusable" behavior.

When a `Context` prunes, artifacts justified by the removed assumptions must no
longer be selected.

Because `Context` already has ancestry semantics, cache validity can follow:

- an artifact built for context `C` is usable exactly when active context is
  `C` or another context judged equivalent by the evaluator's reuse policy;
- on prune to ancestor `A`, future dispatch selects the best surviving artifact
  for `A`.

Engine tasks:

- define the contract the specialized-body lane expects from evaluator-owned
  caches
- support exact-hit and ancestor/equivalence lookup as a documented policy
- ensure no dependence on shared AST rollback

Deliverable:

- lookup/reuse policy doc + tests
- no new shared cache abstraction in v1

---

## 6. Integrate with current JIT relevance machinery

Today `src/conductor/svml-jit-analysis.ts` already tracks JIT-relevant
narrowings (`JIT_RELEVANT_NARROWINGS`), recompiles backend IR when relevant
facts change, and memoizes by active speculation context.

So this step is **integration and upward hoisting**, not replacement-from-zero.

For the new lane:

- keep that analysis as the backend patching hook if still useful;
- but shift speculative reasoning upward so the backend consumes a prepared
  specialized body rather than rediscovering speculation ad hoc.

Target direction:

- `svml-compiler.ts` should consume an already-specialized body or an explicit
  entry guard spec, not contain the primary speculation policy.

This does **not** need full cleanup in v1, but the plan should move in that
Direction.

Deliverable:

- first integration path where SVML compiles from specialized cloned body for at
  least one optimization family
- follow-up cleanup item to delete duplicated speculation logic from backend

---

## 7. Keep ROOT transforms unchanged

Current transform contract stays:

- permanent
- shared AST
- ROOT-only

This is important.

The new speculative lane should be documented as:

- not a transform in the existing sense
- not allowed to mutate canonical AST
- not allowed to widen transform read surfaces

Deliverable:

- docs update clarifying the third lane
- no type-surface weakening around `TransformFactView`

---

## Minimal API by phase

The criterion for adding a public noun is not "we might want it in v3".
It is:

- does it mark a real soundness boundary now?
- does it match an already-existing lifecycle boundary now?
- is it likely to survive expansion without becoming misleading?

Under that test, v1 should stay very small.

### Minimal v1 public API

v1 needs only two real public concepts:

1. **Entry guards** — the projection from general `Context` into the subset of
   assumptions that are checkable at function entry.
2. **Specialized body** — a cloned, rewritten, compilation-only body derived
   from those guards.

Everything else, especially version caching and artifact reuse, should remain
owned by the evaluator/JIT path for now because `src/conductor/svml-jit-analysis.ts`
already has that machinery.

Suggested v1 API:

```ts
export type EntryGuard =
  | { kind: "param-const"; paramIndex: number; value: unknown }
  | { kind: "param-type"; paramIndex: number; ty: unknown };

export function entryGuardsFor(
  unit: Unit,
  context: Context,
): readonly EntryGuard[] | undefined;

/** Returns a cloned, rewritten body for speculative compilation.
 *  Never mutates canonical AST. Returned nodes preserve original NodeIds
 *  and must not be inserted into topology / CFG / analysis stores. */
export function specializedBodyFor(
  unit: Unit,
  context: Context,
): ReadonlyArray<StmtNS.Stmt> | undefined;
```

Notes:

- `entryGuardsFor(...)` is the projection boundary.
- `specializedBodyFor(...)` is the artifact boundary.
- version caching/reuse remains evaluator-owned in v1.
- helper functions like `cloneSpecializedBody(...)` or internal rewrite passes
  may exist, but do not need to be public API nouns.

### Minimal v2 API growth

v2 should add API only if duplication appears in two consumers or if a new
soundness boundary shows up.

Likely v2 additions:

```ts
/** Optional, only if projected-guard equivalence becomes a real shared need. */
export function guardKeyFor(
  unit: Unit,
  context: Context,
): string | undefined;

/** Optional, only if backends need guards without asking for a cloned body. */
export function hasSpecializedBody(
  unit: Unit,
  context: Context,
): boolean;
```

What should still *not* become public in v2 unless forced by real duplication:

- `FunctionVersion`
- `FunctionVersionStore`
- generic specialization backend interfaces
- clone-local analysis / remap frameworks

Those are candidates only if at least two backends need to share the same
version-storage and reuse semantics rather than each adapting the existing JIT
shape.

### What would justify a v3+ API expansion?

Only one of these:

- two backends are both carrying materially duplicated `(Unit, Context)`
  version caches;
- projected-guard equivalence becomes a shared policy rather than an SVML-only
  integration detail;
- clone-local analyses or fresh-`NodeId` remapping become unavoidable for
  more powerful rewrite families.

Until then, keep the public surface at the `entryGuardsFor` /
`specializedBodyFor` level.

## Concrete guard forms for existing `Narrowing`s

The projection boundary should be explicit per narrowing kind.

### `constNarrowing`

Source today:

- handle: `constExprHandle`
- observation source: `runtimeWriteAnalysis`
- key space: `NodeId`

Entry-guardable form in v1:

- allowed only when the narrowed `NodeId` is a read of one of the callee's
  parameters;
- projected guard:

```ts
{ kind: "param-const", paramIndex, value }
```

Rejected in v1 when:

- the `NodeId` refers to an interior local;
- the value cannot be represented in the chosen entry-guard vocabulary;
- the fact depends on anything other than a direct parameter read.

### `typeNarrowing`

Source today:

- handle: `typeExprHandle`
- observation source: `runtimeWriteAnalysis`
- key space: `NodeId`

Entry-guardable form in v1:

- allowed only when the narrowed `NodeId` is a read of one of the callee's
  parameters;
- projected guard:

```ts
{ kind: "param-type", paramIndex, ty }
```

Rejected in v1 when:

- the `NodeId` is not a parameter read;
- the type fact is not expressible by a cheap entry check;
- the narrowing only becomes useful through interior path structure.

### `returnKindNarrowing`

Source today:

- handle: `returnKindHandle`
- observation source: `runtimeReturnAnalysis`
- key space: `FunctionId`
- current consumer surface: `requirementAtEntry(unit, context)` in
  `src/specialization/type-requirement-analysis/analysis.ts`

Important distinction:

- `returnKindNarrowing` does **not** map directly to one entry guard by reading
  its raw `(handle, key, value)` triple.
- Instead, it induces a backward analysis whose entry result expresses which
  parameter requirements would make that return-kind assumption hold.

Entry-guardable form in v1:

- read `requirementAtEntry(unit, context)`;
- if `unprovable` is non-empty, reject specialization for this route;
- otherwise each `provable` slot projects to a parameter type guard:

```ts
{ kind: "param-type", paramIndex, ty }
```

So `returnKindNarrowing` is admitted only through this derived projection:

```ts
(returnKind assumption on functionId)
  -> typeRequirementAnalysis under context
  -> requirementAtEntry(unit, context)
  -> zero or more { kind: "param-type", ... } guards
```

This keeps the API honest: the guardable thing is the derived parameter-entry
requirement, not the raw return observation itself.

### Default v1 policy

If we want the smallest sound first implementation:

- allow `constNarrowing` -> `param-const`
- allow `typeNarrowing` -> `param-type`
- allow `returnKindNarrowing` only through `requirementAtEntry(...)`
- reject every other present/future narrowing until it has an explicit
  projection rule in this section

---

## Minimal implementation order

### Phase 1: narrow, prove, no cleanup

1. define entry-specializable assumption subset
2. implement `entryGuardsFor(unit, context)`
3. implement `specializedBodyFor(unit, context)` using the v1 NodeId-shadow
   policy
4. add one speculative rewrite:
   - branch pruning from parameter const assumption
5. compile the specialized body in one backend path **in parallel with**
   existing backend logic
6. validate cache selection/fallback by `Context`
7. add one benchmark/example where AOT cannot perform the same rewrite

### Phase 2: broaden within same contract

1. add parameter kind-based numeric specialization
2. share specialized-clone pipeline with both backends
3. add lightweight profitability thresholding
4. add version eviction / cap policy

### Phase 3: cleanup / deletion

1. only after equivalence/value proof, remove duplicated speculation logic from
   `svml-compiler.ts` where the cloned specialized-body lane supersedes it
2. reduce backend-specific speculation policy to guard emission / artifact
   production only

---

## Suggested file touch points

Likely affected:

- `src/specialization/framework/context.ts`
  - mostly reused, maybe helper utilities only
- `src/specialization/framework/worklist.ts`
  - expose/route active per-`Unit` context changes to specialization helpers,
    if the evaluator cannot already observe them sufficiently
- `src/specialization/framework/dfa-analyses.ts`
  - likely home for reuse of `JIT_RELEVANT_NARROWINGS` and/or shared metadata
    if the subset remains framework-visible
- `src/specialization/framework/runtime-analyses.ts`
  - possible home if the entry-specializable subset is better expressed next to
    the observation/narrowing sources themselves
- `src/conductor/svml-jit-analysis.ts`
  - integrate specialized-body use, cache selection, and artifact publication
- `src/engines/svml/svml-compiler.ts`
  - consume specialized cloned body and/or reduced guard spec
- CSE backend entry path(s)
  - consume specialized cloned body for future dispatch
- `docs/fact-surfaces-and-speculation.md`
- `docs/transform-authoring-tutorial.md`
- new design note for entry-guarded speculative specialization

Potential new modules:

- `src/specialization/entry-guards.ts`
- `src/specialization/speculative-clone.ts`
- `src/specialization/speculative-rewrites/*`

These names are placeholders; keep noun count low.

---

## Required tests

### Soundness boundary tests

- specialized body never mutates shared AST
- ROOT transforms remain unable to read non-ROOT facts
- non-entry-guardable assumptions are rejected

### Context/cache tests

- same `Context` reuses the same evaluator-owned cache key/policy outcome
- child context falls back to ancestor version after prune
- unrelated sibling contexts do not alias incorrectly

### Rewrite tests

- parameter-const branch pruning on cloned body only
- parameter-kind numeric specialization on cloned body only
- nested function bodies remain untouched unless explicitly supported later

### Backend integration tests

- future dispatch sees specialized artifact/body-derived compile result
- active calls remain on old version
- fallback after context prune selects baseline/ancestor version

### Value tests

- at least one script where ROOT/AOT cannot eliminate a branch but speculative
  entry specialization can
- at least one script where parameter kind specialization improves emitted
  backend artifact shape

---

## Acceptance criteria for v1

The design is successful if all are true:

1. Shared AST remains ROOT-owned and speculation-free.
2. Only parameter-entry assumptions justify specialization.
3. The public specialization API is no larger than the minimal v1 surface
   above (`EntryGuard`, `entryGuardsFor`, `specializedBodyFor`) unless a new
   boundary is proven necessary during implementation.
4. At least one optimization currently embedded in SVML speculation logic is
   implemented in the specialization-engine cloned-body lane **in parallel**,
   validated, and only then considered for backend deletion.
5. There exists at least one benchmark/example where speculative function-entry
   specialization outperforms ROOT-only AOT specialization.

## Done criteria beyond v1

### v2 is done when

- at least two speculative rewrite families exist and still fit the same
  public API;
- at least one second consumer/backend path can use the specialization lane
  without forcing a new abstraction stack;
- any added API is justified by actual duplication, not anticipated reuse.

### The overall direction is done when

we have reached the smallest stable public surface that supports the intended
specialization family, and further improvements are mostly about adding new
rewrite rules / heuristics rather than inventing new public nouns.

Concretely:

- if future work mostly extends `EntryGuard` variants or rewrite coverage,
  the architecture is in the right shape;
- if every new optimization forces another public manager/registry/interface,
  the architecture is not done and is likely over-factored.

---

## Open questions

1. Should specialized bodies be materialized as cloned PyAST only, or should a
   backend be allowed to keep only backend-specific artifacts plus an optional
   debug clone?
2. Should version lookup require exact `Context` hit or allow ancestor/derived
   equivalence by projected guard set?
3. Do parameter constant observations deserve v1, or should v1 ship with kind
   checks only?
4. What profitability threshold is enough to avoid churn without hiding the
   proof-of-concept win?
5. Which single existing SVML speculative optimization is the best first one to
   hoist upward into this lane?

---

## Recommendation

Start with the smallest proof:

- reuse `Context`
- parameter-entry assumptions only
- one speculative cloned-body rewrite (`if x == 0`-style branch pruning)
- one backend integration path
- one benchmark proving JIT-only value

Only after that works should the system expand toward broader speculative
specialization.