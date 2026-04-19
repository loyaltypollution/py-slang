# Specialization author guides

This directory now has multiple author-facing tutorials because the
specialization engine has multiple independent extension roles.

That is deliberate.

One of the main architectural lessons in this codebase is that these roles are
**not the same kind of thing**:

- an **analysis author** defines a monotone fact computation;
- a **transform author** writes an imperative AST rewrite driven by settled
  facts;
- an **evaluator author** connects a backend/runtime to the specialization
  engine and deopt/speculation protocol;
- a **profile author** defines new runtime-observation or profitability
  channels and decides how they feed speculation, policy, or both.

Trying to explain them with one vocabulary is how the design becomes more
uniform on paper than it is in code.

So these guides are split by author role.

---

## 1. The theory of the model

The specialization architecture has a one-way shape:

```text
runtime observations / program structure
  -> analyses compute facts
  -> transforms consume ROOT facts and rewrite AST
  -> evaluators / backends may consume speculative facts under guards
```

The load-bearing distinction is between four categories:

1. **semantic ROOT facts** — stable truths derived from the program;
2. **speculative facts** — non-ROOT narrowed facts justified by observations;
3. **runtime observations** — what the runtime has seen;
4. **profitability signals** — counters / heuristics deciding whether work is worth doing.

Each author role touches different parts of that pipeline.

---

## 2. Which guide to read

### Analysis authors

Read:

- `docs/dfa-framework-tutorial.md`
- `docs/narrowing-authoring-tutorial.md` (if the analysis participates in speculation)
- `docs/topology-and-key-spaces-tutorial.md`
- `docs/fact-surfaces-and-speculation.md`
- `docs/must-analysis-review.md` (for current must-style support boundaries)
- `src/specialization/framework/{analysis,analysis-store,dfa-factory,worklist}.ts`

Analysis authors define monotone computations over per-analysis stores.
They care about:

- key spaces;
- store algebras / lattices;
- transfer monotonicity;
- wake edges;
- speculation narrowings when applicable.

### Transform authors

Read:

- `docs/transform-authoring-tutorial.md`
- `docs/function-structure-mutation-tutorial.md` (if the transform adds/removes functions)
- `docs/topology-and-key-spaces-tutorial.md`
- `docs/fact-surfaces-and-speculation.md`
- `src/specialization/framework/{analysis,transform-rule,worklist,interfaces}.ts`

Transform authors consume facts and rewrite ASTs.
They care about:

- ROOT-only reads;
- `TransformFactView`;
- `unitSweepRule(...)`;
- idempotency;
- CFG rebuild semantics;
- the function-registry contract when changing function structure.

### Evaluator / backend authors

Read:

- `docs/evaluator-authoring-tutorial.md`
- `docs/guard-and-deopt-tutorial.md`
- `docs/topology-and-key-spaces-tutorial.md`
- `src/conductor/PySvmlJitEvaluator.ts`
- `src/conductor/svml-jit-analysis.ts`
- `src/specialization/dfa-query.ts`
- `src/specialization/framework/runtime-analyses.ts`

Evaluator authors wire a runtime/backend to specialization.
They care about:

- how to build a `Worklist` and drain it;
- which fact surface is safe for backend compilation;
- how runtime observations are reported;
- how guards register provenance for deopt;
- where backend-specific logic belongs versus framework logic.

### Profile / observation authors

Read:

- `docs/profile-authoring-tutorial.md`
- `docs/narrowing-authoring-tutorial.md` (if the signal feeds speculation)
- `docs/topology-and-key-spaces-tutorial.md`
- `docs/fact-surfaces-and-speculation.md`
- `src/specialization/framework/runtime-analyses.ts`
- `src/specialization/framework/{analysis,worklist,speculation-strategy,dfa-analyses}.ts`

Profile authors define new runtime-observation or profitability channels.
They care about:

- whether the signal is semantic, speculative, observational, or profitability-only;
- `onObserve` behavior;
- saturation / conflict behavior of the store algebra;
- whether the signal should extend speculation contexts;
- whether the signal should instead remain a transform/backend policy input only.

---

## 3. Why this split is architecturally useful

Splitting the tutorials by role does more than improve docs.
It also gives us a way to inspect the architecture itself.

A good author guide should make each role answer three questions clearly:

1. **What is the theory?**
   What kind of thing is this role modeling?
2. **What is the mechanism?**
   Which APIs and files does the author actually touch?
3. **What are the hazards?**
   Which mistakes make the system unsound, expensive, or confusing?

Whenever one role's guide needs to explain machinery belonging to another role,
that is often a sign of architectural tension or over-coupling.

Examples of useful tension signals:

- a transform author needing speculation internals;
- an evaluator author needing to know too much about one concrete analysis;
- a profile author having to edit multiple unrelated framework modules to add a
  single observation dimension;
- an analysis author needing evaluator-specific concepts to define transfer.

That is exactly the kind of pressure these guides can surface and turn into
engine simplification work.

---

## 4. Current guide set

Core role guides:

- `docs/dfa-framework-tutorial.md`
- `docs/transform-authoring-tutorial.md`
- `docs/evaluator-authoring-tutorial.md`
- `docs/profile-authoring-tutorial.md`

Architecture boundary notes:

- `docs/fact-surfaces-and-speculation.md`
- `docs/must-analysis-review.md`

Focused companion guides:

- `docs/narrowing-authoring-tutorial.md`
- `docs/topology-and-key-spaces-tutorial.md`
- `docs/function-structure-mutation-tutorial.md`
- `docs/guard-and-deopt-tutorial.md`

---

## 5. Suggested review questions for future guides

For every author-facing tutorial we add, ask:

- Does it start with the theory of the model, not just API calls?
- Does it say what the role is **not** allowed to do?
- Does it separate stable contracts from current implementation details?
- Does it point to real code examples?
- Does writing the guide reveal places where the architecture is harder to
  explain than it should be?

If a guide is hard to write clearly, that may be evidence that the underlying
surface is still too tangled.
