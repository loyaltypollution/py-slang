# Specialization framework: authoritative next steps

This is the single planning note for the post-`FactStore` / post-`DfaBlockFact`
framework.

The old notes in:

- `docs/dream-state-analysis-stack.md`
- `docs/factstore-keyspaces-and-domains.md`
- `docs/factstore-analysis-classification.md`
- `factstore-lattice-unification-plan.md`

are historical only. They were useful while the architecture was still being
named, but they now mix three kinds of stale content:

- assumptions that were true before `AnalysisStore` / citizen-split landed;
- concerns that disappeared once `DfaBlockFact` and `FactStore` were removed;
- intentions that are still right, but whose interface has shifted.

This file replaces them.

---

## Current architecture, as it actually exists

### 1. Analysis identity is a singleton + store algebra + transfer + owned storage

Each scheduled analysis is an `Analysis<K, V>` singleton defined once and owning
its own `AnalysisStore<K, V>`.

What that means in practice:

- storage is per-analysis, not in a global fact registry;
- `storeAlgebra` is the algebra of the stored cell domain `V`;
- `emptyValue` names unwritten-cell semantics when `bottom` is not the right
  default to infer implicitly;
- `transfer(ctx, key)` computes the next stored value for that analysis.

### 2. Block DFAs are paired analyses, not one compound stored cell

`makeBlockFixpointAnalysis(...)` now produces:

- `.env: Analysis<BasicBlock, MutableEnv<L>>`
- `.facts: Analysis<BasicBlock, ReadonlyMap<number, L>>`

This is the real split in the system:

- `.env` is the fixpoint driver and CFG-propagated summary surface;
- `.facts` is the per-node fact surface and sentinel store;
- the worklist dispatches each separately, so expr-fact-only changes no longer
  pretend to be CFG-propagation changes.

### 3. Worklist is the scheduler and the change-dispatch hub

`src/specialization/framework/worklist.ts` is the one place that:

- drains the analysis queue;
- dispatches fact-change edges;
- dispatches lifecycle events;
- drives transform dirtying/sweeps;
- routes observation-driven speculation updates.

A write is only fully "real" when it goes through worklist dispatch.

### 4. `AnalysisCtx` is the transfer-visible read/write surface

Transfers and edge wake/effect code do not own dispatch.
They see an `AnalysisCtx` that:

- reads at `currentContext`;
- writes through the worklist so listeners stay consistent;
- evicts at `currentContext`.

That boundary is sound for transfer-time computation, but lifecycle cleanup that
must span *all* contexts cannot rely on `currentContext`; it must sweep the
analysis-owned store across its context partitions directly.

### 5. Citizen kinds are split

The framework now has meaningfully different roles:

- `Analysis<K, V>` — scheduled, stored, dispatched computations;
- `AssumptionHandle<K, V>` — context namespace tokens with equality only;
- `TransformRule` — imperative root-only AST sweeps;
- `Narrowing<K, V>` — observation-to-context bridge objects.

This split is real and should stay visible.

### 6. Key spaces are explicit program topology, not one generic universe

The important key spaces today are:

- `nodeId`
- `FunctionId`
- `BasicBlock`
- `Unit`

Bridges between them are not accidental glue; they are the framework's topology
layer (`ProgramTopology`, `readExprFact`, `resolveUnit`, etc.).

---

## What truly still needs doing

The major architectural simplification is already done. The remaining work is
mostly about making the new contracts harder to misuse and easier to review.

### A. Make lifecycle-wide cleanup impossible to get wrong

**Why:**
Lifecycle events (`mint`, `rebuild`, `retire`, `specContextChange`) are unit-
level events, but `AnalysisStore` is partitioned by `Context`. Any cleanup that
means "drop all cells for this unit" must sweep *every* context, not just ROOT.

A concrete soundness bug existed here and is now fixed for block analyses:
`src/specialization/framework/dfa-factory.ts` evicts stale `.env` / `.facts`
block cells across all store contexts on rebuild/retire.

**What remains:**
Keep this invariant explicit everywhere new lifecycle cleanup is added.

**Light suggestion on how:**
When cleanup semantics are "all cells for this unit/key family", use the
analysis-owned store as the source of truth and iterate its contexts directly.
Do not infer that a lifecycle callback's `ctx.currentContext` tells you the full
cleanup scope.

### B. Keep the root-only transform boundary strict

**Why:**
Permanent AST rewrites must not consume speculative facts.
This remains the central semantic/speculative safety boundary.

**What remains:**
Preserve the contract that transforms only see `TransformFactView`, which reads
ROOT cells only.

**Light suggestion on how:**
If a future optimization needs speculative facts, model it as guarded backend
selection / compilation, not as an unconditional AST transform.

### C. Keep observation-driven speculation separate from semantic facts

**Why:**
The framework is now clear enough that this separation should stay mechanical,
not rhetorical:

- runtime observations accumulate in opaque runtime analyses;
- narrowings extend non-ROOT contexts;
- speculative reads are opt-in and guarded;
- baseline semantic facts remain readable at ROOT.

**What remains:**
Avoid reintroducing helper surfaces that blur ROOT and speculative reads.

**Light suggestion on how:**
New readers should choose one of three explicit shapes:

- ROOT-only transform/query surface;
- transfer-local `AnalysisCtx` read surface;
- explicit store read with an explicit `Context`.

### D. Keep the citizen split and topology vocabulary intact

**Why:**
A lot of the earlier confusion came from structurally similar things being
presented as though they were one category.
That confusion is much lower now.

**What remains:**
Preserve the language and type boundaries around:

- scheduled analyses,
- assumption handles,
- transforms,
- program topology bridges.

**Light suggestion on how:**
Prefer small helper APIs that name a bridge (`blockOfNode`, `unitOfFunctionId`,
`readExprFact`) over generic helpers that hide which key space is being crossed.

### E. Keep comments/tests aligned with the new interfaces

**Why:**
The biggest remaining source of confusion is stale explanation, not stale
implementation.

**What remains:**
As new work lands, update comments/tests to describe:

- `AnalysisStore`, not `FactStore`;
- paired `.env` / `.facts` analyses, not `DfaBlockFact`;
- `FunctionId`, not the old `fdId` wording where the semantic distinction
  matters.

**Light suggestion on how:**
Treat stale architectural comments as correctness debt. If a change alters a
boundary, update the nearest architectural comment and one regression test in
that same patch.

---

## What does *not* currently need doing

These were active concerns in the older notes, but they are no longer the right
next steps.

### Not a current task: re-theorize one global "FactStore lattice"

That concern belonged to the old interface.
The new code already names the real contract more honestly:
`storeAlgebra` is the algebra of the stored cell domain owned by one analysis.

### Not a current task: recover `DfaBlockFact`

The env/facts split was the right simplification.
The meaningful boundary now is between CFG-propagated env cells and per-node
fact cells, not between an "inner" and "outer" summary object bundled back
into one stored cell.

### Not a current task: collapse citizen kinds back together

`AssumptionHandle`, `Analysis`, `TransformRule`, and `Narrowing` overlap in how
some code talks about them, but they should not be recompressed into one more
abstract interface.

### Not a current task: infer absent-cell meaning from may/must polarity alone

Absent-cell semantics live on the stored cell contract (`emptyValue` /
`storeAlgebra.bottom`), not on `polarity` by itself.

---

## Practical review checklist for future changes

When reviewing a framework change, the important questions are now:

1. What key space does this thing live on?
2. Is it a scheduled analysis, an assumption handle, a transform, or a
   narrowing?
3. What is the stored cell domain?
4. Which reads are ROOT-only, and which are context-explicit?
5. If lifecycle cleanup runs, does it need one context or all contexts?
6. Does every side-effect write still route through worklist dispatch?

If those answers are obvious, the architecture is still legible.

---

## Cold-start reading order

For someone arriving fresh, read these first:

- `src/specialization/framework/analysis.ts`
- `src/specialization/framework/analysis-store.ts`
- `src/specialization/framework/worklist.ts`
- `src/specialization/framework/dfa-factory.ts`
- `src/specialization/framework/transform-rule.ts`
- `src/specialization/framework/topology.ts`
- `src/tests/specialization/framework/analysis-store.test.ts`
- `src/tests/specialization/framework/analysis-graph-dispatch.test.ts`
- `src/tests/specialization/framework/function-registry.test.ts`

That set captures the real current contracts better than the older planning
notes did.
