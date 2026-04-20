# Plan: unify transforms around minimal witnessing assumptions

## Goal

Move the specialization engine toward one consistent future architecture:

1. **All transforms operate on the minimal assumption needed to justify the rewrite.**
   Not ROOT-by-default, not deepest-current-context by default.
2. **Assumption coarsening is policy, not transform logic.**
   If observations `x = 60` and `x = 120` should converge to `x : int` or
   `x : pos-int`, that decision belongs in the narrowing/speculation policy.
3. **Transforms should not know AssumptionChain internals.**
   A transform should ask for “the shallowest witness that makes this rewrite
   sound” through a small API, not manually walk parents or inspect assumption
   shapes.
4. **Keep the proof of concept minimal and theoretically consistent.**
   Prefer one uniform rule over special cases (`ROOT` transforms here,
   evaluator-local widening there, ad hoc memoization policy elsewhere).

---

## Current problem

The current codebase still has two conflicting architectures:

- Analyses already run on speculative `AssumptionChain`s.
- Shared transforms still sweep with `ROOT` facts only.
- Evaluator-local artifact generation (`svml-jit-analysis.ts`) compensates by
  adding local widening/coarsening logic.

That split is the source of drift.

Examples of the drift surface today:

- A transform justified by a speculative fact cannot naturally express the
  minimum context that makes it sound.
- Memoization policy in `svml-jit-analysis.ts` widens const contexts to type
  guards locally instead of reading a canonical minimal witness from the engine.
- ROOT-only transform sweeping is a regression relative to the intended model:
  the engine already has a context lattice, but the transform surface refuses to
  use it.

The future architecture should remove this split rather than preserve it.

---

## Intended contract

### Core rule

> Every transform fires against the **minimal witnessing assumption chain** that
> makes its rewrite sound.

That means:

- If a rewrite is already justified at `ROOT_CONTEXT`, the transform acts as a
  ROOT rewrite.
- If a rewrite needs a speculative assumption, the transform acts at the
  shallowest speculative context that still justifies it.
- If two deep contexts share the same shallower witness, they should converge on
  the same transformed artifact / transformed view.

This contract should hold for:

- dead branch elimination
- constant folding
- memoization
- future speculative transforms

The transform author should not need to know whether the winning witness was:

- `ROOT_CONTEXT`
- `{x = 60}`
- `{x : int}`
- `{x : pos-int}`
- `{returnKind(f) = int}`

They should only ask for the shallowest context that proves the predicate they
care about.

---

## Assumption chains and transform triggering

Assumptions already form a chain. As runtime observations enter the engine:

1. policy decides whether and how to narrow
2. the worklist extends/coarsens the active chain
3. analyses run under that chain
4. analyses wake transforms
5. transforms should then recover the **minimal witness** from the chain before
   deciding how specific the rewrite needs to be

So transforms do **not** need a separate bespoke widening phase. They need a
canonical API that says, effectively:

- here is the current chain
- here is the fact/predicate I care about
- give me the shallowest witness where it still holds

This makes the transform surface transparent to chain internals.

---

## Policy owns narrowing/coarsening

### Principle

> Coarsening `x = 60`, `x = 120`, `x = 8` into a reusable abstract assumption is
> a policy decision, not a transform decision.

Transforms should never locally decide:

- “for memoization, rewrite const to type”
- “for this backend, collapse value guards to kind guards”
- “for this rule, walk up until the chain looks reusable enough”

Those are policy responsibilities.

### Immediate proof-of-concept policy

For the minimal PoC:

- do **not** try to infer arbitrarily rich abstract predicates yet
- let policy coarsen observations into **type-domain assumptions only**
- use the most precise abstract type already available in the lattice, e.g.
  `POS`, `ZERO`, `NEG`, numeric kind masks, boolean truth, etc.

So repeated concrete observations like:

- `x = 60`
- `x = 120`
- `x = 8`

should converge, via policy, not transform code, toward something like:

- `x : pos-int`

rather than leaving each transform to rediscover that generalization itself.

This gives the academic PoC a clean story:

- observations enter concretely
- policy abstracts them into a reusable narrowing domain
- analyses consume those abstract assumptions
- transforms ask for the minimal witness under that abstract domain

One pipeline, one semantics.

---

## Consequences for examples

### Fibonacci

If memoization is justified by:

- hotness (ROOT profitability fact)
- purity (already true at ROOT)

then the minimal witness is `ROOT_CONTEXT`.

So the memoization transform should naturally become a ROOT rewrite / ROOT
artifact with no speculative guard pollution.

### Collatz

If purity becomes true only once the non-positive branch is excluded, and policy
coarsens repeated positive observations to `x : pos-int`, then the transform’s
minimal witness should be that abstract type assumption, not a concrete value
like `{x = 60}`.

So the rewrite should be guarded/partitioned at the policy-produced abstract
assumption level.

This is exactly the effect we want:

- no `GUARD_VAL(x, 60)` cache thrash
- one artifact / transform instance for the reusable abstract witness
- no ad hoc evaluator-local widening logic

---

## Required API shape

### Principle: one reader, one noun

The reading surface lives on **`AssumptionChain` itself**. Nothing else can read
facts. `analysis.store` is package-private; `TransformFactView` does not exist;
`ROOT_CONTEXT` is not a module-level import — it is `engine.rootChain`, handed
out by the engine.

This is the load-bearing move: the contract is enforced structurally, not by
convention or lint. A helper that wants to read must accept a chain. A helper
that has no chain argument cannot reach into the store — there is no API for
it.

### The chain's reader surface

```ts
interface Reading<V> {
  readonly value: V;
  readonly witness: AssumptionChain;
}

class AssumptionChain {
  // positional
  read<V>(a: Analysis<..., V>, key): V
  tryRead<V>(a: Analysis<..., V>, key): V | undefined

  // walk toward ROOT, return shallowest witness satisfying `accept`
  readMinimal<V>(a, key, accept): Reading<V> | undefined
  readExprFactMinimal<V>(a, nodeId, accept): Reading<V> | undefined

  // publish at the chain's context; `reading.witness` must be an ancestor
  forkBody(unit, reading): Stmt[]

  readonly parent: AssumptionChain | undefined
}
```

Usage looks identical for transforms and analyses:

```ts
const r = chain.readMinimal(purityScopeAnalysis, fd.id, v => v === true)
```

No `parent` walking, no interner details, no `TransformFactView`, no
`ROOT_CONTEXT` import. One API, one noun along the reading axis.

### Profile/root reads

Profile counters are ROOT-keyed by design (policy §). They read as
`engine.rootChain.read(counter, key)` — no special `readProfitability` helper,
just explicit root reach. The intent is visible at the call site.

---

## Architectural cleanup implied by this plan

### 1. Stop treating ROOT-only transforms as the intended steady state

Current `rootTransformFacts(...)` should be viewed as a temporary limitation, not
as the architecture to preserve.

Future direction:

- transforms become context-aware
- but they act on the **minimal witness**, not the deepest speculative chain

### 2. Delete local widening logic from consumers

Once minimal-witness reads exist, these patterns become architectural smells:

- memoization-specific guard widening in `svml-jit-analysis.ts`
- ad hoc guard-key rewriting
- special-case “compiled guard” derivations that re-interpret the chain locally

### 3. Keep policy and transform roles separate

Policy decides:

- when to speculate
- how to abstract/coarsen observations
- what assumption domain to extend the chain with

Transforms decide:

- given the current chain and facts, whether a rewrite is justified
- what the minimal witness for that rewrite is
- how to publish the rewrite/artifact from that witness

---

## Publication model for the future architecture

This plan intentionally changes the transform contract, so publication must be
made explicit.

The intended semantics are:

- a transform justified at witness `W` publishes a rewrite/artifact associated
  with `W`
- deeper contexts that refine `W` reuse that transformed result
- if `W = ROOT_CONTEXT`, the rewrite is globally visible
- if `W != ROOT_CONTEXT`, visibility follows that witness, not arbitrary deeper
  descendants

For the PoC, this may initially mean transformed **artifacts/views** rather than
immediate in-place mutation of one canonical AST for every non-ROOT witness.
The important contract is the witness discipline, not the first publication
mechanism.

But the architecture should point toward one unified model, not keep “shared AST
ROOT transforms” and “speculative evaluator-local rewrites” as unrelated worlds.

---

## Minimal implementation plan

### Phase 1 (done): witness API

`Reading<V>`, `readAt`, `readMinimal`, `readExprFactMinimal`, `bodyAtWitness`
exist on `TransformFactView`. Reuses the worklist's lineage walk.

### Phase 2 (done): transform-facing witness reads

Transform surfaces carry the minimal-witness API; transforms no longer walk
chain internals.

### Phase 3 (done): memoization on the canonical contract

Memoization asks for minimal witness of purity/hotness; guard/key/artifact
identity derived from the witness; local widening deleted.

### Phase 4: collapse the reader onto `AssumptionChain`, generalize to all transforms

Phases 1–3 layered a facade (`TransformFactView`) over a still-public
`analysis.store`. That leaves two ways to read — the sanctioned view and the
raw store — and ROOT-hardcoded helpers (e.g. `liveness-analysis/analysis.ts`'s
`liveOutOf`) have been reaching past the view to the store. Phase 4 removes
the second way.

**Structural changes:**

1. Move `read`, `tryRead`, `readMinimal`, `readExprFactMinimal`, `forkBody`
   onto `AssumptionChain`. Delegate to the existing store internally.
2. Delete `TransformFactView` and `transformFacts(...)`. Transform sweep
   callbacks receive `(unit, chain)` instead of `(unit, facts)`.
3. Mark `analysis.store` package-private. Only `framework/worklist.ts` and the
   chain's own methods touch it.
4. Remove `ROOT_CONTEXT` as a module-level export. Each engine exposes its own
   `engine.rootChain`. Helpers that legitimately need root reads (profile
   counters in `runtime-analyses.ts`, `svml-jit-analysis.ts`) receive the root
   chain explicitly.
5. Drop the `readProfitability` helper; profile reads are
   `rootChain.read(counter, key)`.

**Migration by site class:**

- *Mechanical swap* (~40 sites): `x.store.read(k, ctx)` → `ctx.read(x, k)`.
- *Exposed bugs* (helpers with no chain arg currently hardcoding ROOT; the new
  type forces chain threading):
  - `liveness-analysis/analysis.ts:205` — `liveOutOf(block)` →
    `liveOutOf(block, chain)`. This is the Phase 4 dead-store fix.
  - `purity-analysis/analysis.ts:347,508` — ROOT fallback → chain walking.
  - `dfa-query.ts:92-93` — same pattern.
  - `framework/text-formatter.ts:291` — diagnostic; pass chain.
- *Legitimate root reads* (profile channel): explicit `rootChain.read(...)`.
- *Framework internals* (`worklist.ts`, `dfa-factory.ts`): keep direct store
  access — these implement the chain's methods.
- *Tests*: swap mechanically, or prune where they encode the old spec (the
  external evaluation suite is the source of truth for behavior).

**Order of operations:**

1. Add chain methods; delegate to `.store`.
2. Migrate transforms → analyses → tests in waves.
3. Delete `TransformFactView` + `transformFacts(...)`.
4. Mark `analysis.store` package-private.
5. Replace `ROOT_CONTEXT` export with `engine.rootChain`.
6. Liveness + purity chain-walking fixes fall out of (4) — the code stops
   compiling until chain is threaded.

**Why this is phase 4, not phase 1 reworked:** phases 1–3 validated that the
minimal-witness discipline works for the transforms we care about. Phase 4
deletes the old reader so nothing can opt out. Contract-enforcing, not
migratory.

**Non-goals for Phase 4:** a separate `TransferContext` / Reader token type /
arch-test allowlist. These were considered; they add nouns without adding
enforcement beyond what moving the reader onto the chain already provides.

---

## Non-goals for the proof of concept

To keep the PoC minimal, do **not** add all of these at once:

- arbitrary predicate synthesis beyond the existing type lattice
- fully general theorem-proving over assumptions
- backend-specific custom widening rules embedded in transforms

The PoC only needs:

- abstract type-domain coarsening in policy
- minimal-witness lookup in the engine
- transforms/artifacts derived from that witness

That is already enough to demonstrate the core idea cleanly.

---

## Bottom line

The intended future architecture is:

> Observations enter concretely. Policy abstracts them into reusable type-domain
> assumptions. Analyses run on assumption chains. Every transform consumes facts
> through a minimal-witness API and therefore acts on the shallowest assumption
> that makes it sound.

That is the simplest theoretically consistent PoC.

It removes:

- ROOT-only transform special-casing as the architectural default
- evaluator-local widening hacks
- per-transform ad hoc coarsening logic

and replaces them with one uniform contract.
