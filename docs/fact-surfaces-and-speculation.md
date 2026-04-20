# Fact surfaces, speculation, and soundness boundaries

This file is the canonical architecture note for the specialization framework's
soundness boundaries.

It is intentionally narrower than the older DFA tutorial. The goal is not to
explain every mechanism; it is to make the framework's review contracts
explicit, so future changes can be judged against them.

Relevant implementation files:

- `src/specialization/framework/analysis.ts`
- `src/specialization/framework/analysis-store.ts`
- `src/specialization/framework/context.ts`
- `src/specialization/framework/dfa-factory.ts`
- `src/specialization/framework/worklist.ts`
- `src/specialization/type-analysis/analysis.ts`
- `src/specialization/type-requirement-analysis/analysis.ts`

---

## 1. The four categories must stay distinct

### A. Semantic / ROOT facts

These are the facts that hold without speculative assumptions.

Properties:

- stored under `ROOT_CONTEXT`;
- derived from program semantics and transfer logic, not from runtime profiling
  or speculative guards;
- safe to use for unconditional decisions;
- the only fact class unconditional AST transforms may consume.

Examples:

- `constAnalysis` facts at `ROOT_CONTEXT`;
- `typeAnalysis` facts at `ROOT_CONTEXT`;
- any other analysis result whose meaning is intended to survive deopt,
  widening, or recompilation.

Rule:

> If a rewrite or compile-time claim must remain valid after speculation is
> removed, it must be justified by ROOT facts only.

### B. Speculative / non-ROOT facts

These are facts computed under a non-empty `Context` assumption chain.

Properties:

- stored under a non-`ROOT_CONTEXT` context;
- arise by extending a unit's speculation context from runtime observations;
- may be narrower or more profitable than ROOT facts;
- are retractable by guard widening, lineage pruning, or unit-wide fallback to
  ROOT;
- are valid only for guarded compilation or other retractable consumers.

Examples:

- a type fact narrowed by `typeExprHandle` assumptions;
- a constant fact narrowed by `constExprHandle` assumptions;
- requirement propagation under a speculative return-kind assumption.

Rule:

> Non-ROOT facts may influence guarded artifacts, but must not justify
> unconditional AST rewrites.

### C. Runtime observations / profiler evidence

These are raw facts observed from executing the program.

Properties:

- they originate at ROOT via `Worklist.observe(...)`;
- they are inputs to speculation machinery, not semantic truth;
- they may trigger context extension through `onObserve` /
  `handleObservationForSpec`;
- they do not, by themselves, strengthen semantic ROOT facts.

Examples:

- observed write kinds from `runtimeWriteAnalysis`;
- observed return kinds from `runtimeReturnAnalysis`.

Rule:

> Runtime evidence can justify trying a speculative context. It cannot rewrite
> the semantic meaning of ROOT facts.

### D. Profitability signals

These are metadata used to decide whether specialization work is worth doing.

Properties:

- may be monotone counters or saturating metadata;
- influence scheduling, compilation, or optimization profitability;
- are not proofs of source-level semantic properties.

Example:

- call counts from `runtimeCallAnalysis`.

Rule:

> Profitability is never semantic evidence. A hot path is not therefore safe to
> rewrite.

---

## 2. Allowed read surfaces by consumer

### A. Unconditional transforms

Allowed surface:

- `TransformFactView`

What that means for **canonical transforms** (those that mutate `unit.body`
permanently):

- the worklist binds the view at `ROOT_CONTEXT` via `rootTransformFacts(topology)`;
- no writes;
- no arbitrary per-context reads;
- expression facts are accessed only through the root-bound
  `readExprFact(...)` helper on the view;
- `read` / `tryRead` / `readAll` / `readExprFact` accept only
  `SemanticAnalysis<K, V>` — i.e. `polarity: "may" | "must"`. Opaque
  analyses (runtime observations, saturating counters) are rejected at
  the type level so profitability evidence cannot be misread as semantic
  proof;
- profitability reads go through the deliberately renamed
  `readProfitability<K, V>(analysis: OpaqueAnalysis<K, V>, key: K)`. That
  surface exists solely to gate a transform on a policy signal, never to
  justify the rewrite. A grep for `readProfitability` enumerates every
  profitability-gated transform in the tree.

**Scope expansion:** `TransformFactView` can also be bound to a non-ROOT
context via `transformFacts(topology, context)`. That constructor is used by
`speculative-clone.ts` to rewrite ephemeral clone bodies under speculative
facts. Clone bodies are compilation artifacts — never inserted into the shared
program topology — so reading non-ROOT is sound there. Canonical transform
authors (`TransformRule.sweep`) do not call `transformFacts(...)` directly; the
worklist calls `rootTransformFacts(topology)` for them.

Files:

- `src/specialization/framework/analysis.ts`
- `src/specialization/framework/transform-rule.ts`
- `src/specialization/speculative-clone.ts`
- `src/tests/specialization/framework/transform-fact-view-types.ts`
- `src/tests/specialization/framework/transform-boundary-gate.test.ts`
- `docs/transform-authoring-tutorial.md`

Contract:

> Permanent AST rewrites may read only ROOT facts from semantic analyses.
> Profitability signals may gate a rewrite through `readProfitability`,
> but never justify one.
> Ephemeral clone bodies may read non-ROOT facts because they are
> retractable compilation artifacts, not shared program structure.

### B. Guarded compilation / speculative code generation

Allowed surfaces include:

- explicit non-ROOT store reads;
- query helpers that intentionally read the current speculation context;
- lineage / guard registration surfaces that tie emitted artifacts to the
  assumptions they depend on.

This is where speculative precision belongs. These consumers must remain able
to retract or deopt when assumptions are widened.

Contract:

> A consumer may read non-ROOT facts only if the artifact it produces is
> retractable or guard-protected.

### C. Transfer-time / internal framework logic

Allowed surfaces include:

- `AnalysisCtx.read/tryRead/readAll` at `currentContext`;
- explicit cross-context reads when a transfer really needs them;
- `ctx.write(...)` for writes that must publish change events;
- framework-internal mutation through the `storeWrite` / `storeEvict` /
  `storeContexts` helpers in `analysis-store.ts`. These take the
  `ReadonlyAnalysisStore` surface and are the only ways to mutate a cell
  outside the worklist's `writeAndDispatch` path — used for self-eviction
  in lifecycle effects where listener fan-out is intentionally not
  required.

Contract:

> Internal transfers may operate over ROOT or non-ROOT contexts, but they must
> preserve dispatch and context explicitness. External holders of an
> `Analysis<K, V>` reference see `analysis.store` as `ReadonlyAnalysisStore`;
> a silent external `.write` that skips listener fan-out is a type error,
> not a convention.

---

## 3. Context is explicit on purpose

`Context` is the primitive. ROOT is one distinguished context value, not a
fallback.

That is why public store reads require an explicit `context` parameter:

- `analysis.store.read(key, context)`
- `analysis.store.tryRead(key, context)`
- `analysis.store.readAll(context)`

Framework-owned mutation helpers also require an explicit `context`; public
`Analysis.store` is intentionally read-only.

This prevents a historic failure mode:

> forgetting to thread a speculative context and silently reading ROOT instead.

Contract:

> If code wants ROOT, it must say ROOT. If code wants a speculative position,
> it must say which one.

---

## 4. The real fixpoint contract

The scheduler contract is not "generic context magic." It is more specific:

1. within one context, analyses advance monotonically through their store
   algebra;
2. when the active speculation context changes, the worklist does not mutate
   prior context cells downward in place;
3. instead, it re-seeds the relevant analyses under the new context and lets
   them reconverge there;
4. change propagation stays centralized through worklist-routed writes.

In practical terms:

- `AnalysisStore.write(...)` decides whether a cell advanced;
- `Worklist.writeAndDispatch(...)` is the single fan-out hub;
- listeners, edges, and transform dirtying all rely on that centralized
  dispatch path;
- context changes re-run Kildall under a different context rather than
  retroactively "editing" old conclusions.

Contract:

> Monotonicity is per context. Context changes are handled by re-seed and
> re-run, not by pretending one context's fixpoint is another's.

---

## 5. Must-style support: describe it accurately, not defensively

The framework is quadrant-symmetric at the factory level:

- `direction: "forward" | "backward"` chooses seed direction;
- `mergeKind: "may" | "must"` chooses join-vs-meet block merge;
- must analyses supply `Lattice<L>` so `top` / `meet` are available.

That claim is no longer just type-level vocabulary. The in-tree corpus now has
concrete analyses in all four classical quadrants:

- forward + may: `typeAnalysis`, `constAnalysis`, `purityBlockAnalysis`
- forward + must: `definitelyBoundAnalysis`
- backward + may: `livenessAnalysis`
- backward + must: `typeRequirementAnalysis`

The matching review constraint is subtler than the older "describe it
narrowly" warning:

> Do not overclaim uniformity of *mechanics* just because quadrant coverage
> exists.

The four-quadrant claim is earned. What is still analysis-specific is how each
quadrant uses lifted env semantics, seeding discipline, sparse-vs-total slot
representations, and guarded-vs-transform consumers.

A more accurate statement is:

> The framework supports all four classical DFA quadrants, and the current
> corpus exercises all four. The concrete mechanics are still not identical
> across analyses, especially on must-style env behavior.

For the narrower review note on those must-style mechanics, see
`docs/must-analysis-review.md`.

---

## 6. Citizen boundaries matter

The recent simplification depends on keeping distinct citizen kinds distinct.

They are not all one thing:

- `Analysis<K, V>`: scheduled fixpoint producer with a store;
- `AssumptionHandle<K, V>`: namespace token for context-bound assumptions;
- `Narrowing<K, V>`: bridge from runtime observations into context extension;
- `TransformRule`: imperative AST rewrite consumer.

The shared type vocabulary between some of these is structural reuse, not proof
that they have the same semantic role.

Contract:

> Shared shapes do not erase role boundaries.

---

## 7. Review checklist for future changes

When reviewing a change, ask:

1. Does this make runtime evidence look like semantic truth?
2. Does this let a **canonical transform** (`TransformRule.sweep` / `unit.body` mutation) read anything other than ROOT facts? (Clone-body rewrites in `speculative-clone.ts` are intentionally non-ROOT; the distinction matters.)
3. Does this let profitability metadata justify semantic claims?
4. Does this make must-style support sound broader than the code actually
   exercises?
5. Does this bypass `ctx.write(...)` / `Worklist.writeAndDispatch(...)` and risk
   silent listener inconsistency?
6. Does this make context implicit where the framework currently requires it to
   be explicit?
7. Does this mutate speculative results in place where the contract expects
   re-seed and re-run?

If the answer to any of those is yes, the change is touching a soundness
boundary and should be reviewed as architecture, not just implementation.
