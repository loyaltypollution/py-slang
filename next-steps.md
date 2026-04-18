# DFA Framework: Handoff Brief

You're taking over work on the dataflow analysis (DFA) framework under `src/specialization/` in py-slang — a Python-to-SVML compiler with a profile-guided JIT. This document is a **thesis to verify**, not a plan to execute. Each of the claims below is falsifiable against the codebase; if you find one that doesn't hold up, push back rather than building on a bad premise.

## High-level goal

**Speculation and recovery should live in the specialization engine, not be scattered across analyses.**

Any analysis X should be able to run under a set of *assumptions* — "x at node 17 is int", "branch B always takes the true arm" — and produce facts consistent with those assumptions. When an assumption is later invalidated at runtime, the specialization engine recovers: it swaps to a compiled version that didn't depend on the violated assumption, while transforms derived from *unrelated* assumptions stay intact.

Today, speculation is tangled into individual analyses (parallel `speculativeX`/`X` pairs, special accumulation modes, ad-hoc eviction). The refactor pulls it out: analyses compute facts under a context; the engine owns context creation, composition, and recovery.

## Starting orientation

- `src/specialization/framework/dfa-factory.ts` — the Kildall block-fixpoint engine. Reading front-to-back is the fastest route to understanding the framework.
- `src/specialization/framework/dfa-analyses.ts` — wires `constAnalysis`/`typeAnalysis` and their speculative twins. The "overwrite" accumulation mode and eviction hook are the main machinery this refactor displaces.
- `src/specialization/framework/fact-store.ts` — lattice-monotone storage. Small; read it.
- `src/specialization/{const,type,purity,liveness}-analysis/` — the four analyses.

---

## PROBLEM

Five issues, connected. Each is independently verifiable.

### (P1) Widening on may-forward with profile data is mathematically dead weight

The standard `constAnalysis` and `typeAnalysis` are may-forward: their lattice join is set-union. Combining an observation into an existing fact via `join`:

- `join(⊤, const(v)) = ⊤` — once ⊤, always ⊤; observations can't narrow it.
- `join(const(5), const(3)) = ⊤` — conflicting observation makes the fact strictly *less* precise.
- `join(const(5), const(5)) = const(5)` — redundant; static analysis already had it.

**There is no case where widening with an observation yields a stronger fact than static analysis.** `widenConstObservation` in `const-analysis/analysis.ts` is doing work that never enables a transformation. It exists as a safety valve ("at least we don't narrow speculatively in the non-speculative analysis"), but the concept — "enrich a may-lattice with profile data monotonically" — is empty.

**Verify:** trace the call sites of `widenConstObservation`. Find one where its output strictly improves on pure static analysis. If you can, this problem framing is wrong.

### (P2) Narrowing is the only useful profile operation, and it forces a non-monotone workaround

Profile data *can* help via `meet`: `meet(⊤, const(4)) = const(4)` turns a join-saturated ⊤ back into something useful, under the assumption that future runs match the profile. This enables real transformations.

But narrowing is non-monotone — contradicting observations widen back. The current code handles this with three layered hacks:
- A parallel `speculativeX` analysis per quadrant (one-to-one duplication of logic)
- An "overwrite" accumulation lattice that abandons monotone join for structural equality (`dfa-factory.ts:163-171`)
- A block-eviction hook that wipes *all* cells in a unit when any observation changes (`dfa-analyses.ts:40-60`)

The machinery works. It scales badly: every new quadrant needing profile transformations requires another triple. And "invalidate the entire speculative analysis on any change" is the coarsest possible granularity.

**Verify:** count lines of logic in `speculativeConstAnalysisModule` vs. `constAnalysisModule`. Count the branches in `dfa-factory.ts` that switch on `accumulationMode`. Each of these is paying for non-monotonicity in a shape that's forced on the framework by where speculation lives.

### (P3) Speculation lives in the facts, so transforms can't safely consume it

`dfa-analyses.ts:72-78` contains a comment: AST-mutating transforms MUST NOT read speculative analyses. A constant-fold based on a speculation that later fails is an uncorrectable miscompile. The enforcement is a comment and convention.

**Nothing in the type system prevents a new transform from importing `speculativeConstAnalysis`.** The trap is latent: one wrong import and correctness breaks silently. This is a symptom of speculation living in the wrong layer. If speculation were a property of the *context* an analysis runs under, and transforms always ran under `∅`, the type system would make the mistake unrepresentable.

**Verify:** there's nothing to run — `import { speculativeConstAnalysis }` from a new transform file will compile. That's the bug.

### (P4) There's no abstraction over *when* to speculate

The current code narrows on any single observation. One sample, immediate speculation, immediate guard emission. This is a policy choice hardcoded into `narrowConstObservation`. It conflates two distinct concerns:

- **Mechanism**: how does an analysis combine a fact with an observation? (`meet`)
- **Policy**: when is it worth speculating that an observation represents future behavior?

Useful policies that aren't expressible today:
- **Count-based**: speculate only after the same `(site, value)` has been observed N times. A single outlier shouldn't trigger a guarded specialization that immediately deotps.
- **Cost-based**: speculate only when the estimated speedup exceeds the expected deopt cost × failure probability.
- **Chain-based**: speculate B only if A has already been speculated successfully and persisted through several calls.
- **Composed**: count ≥ 10 AND cost-benefit positive AND not recently deopted.

These should be orthogonal to the analyses — you should be able to add a count-based policy without touching `constAnalysis`. Today you can't, because the policy is baked into the analysis's observation-combine function.

**Verify:** try implementing count-based speculation in the current code. You'll find yourself editing `narrowConstObservation` (and a parallel change in type). The edit ISN'T contained in one place — that's the sign the abstraction is wrong.

### (P5) Invalidation is coarse

A guard failure today blacklists the specific node and recompiles the whole function (`PySvmlJitEvaluator.ts:82-92`). There's no way to say "assumption A failed, but transforms derived from unrelated assumption B should survive." Because all speculative facts share a single analysis cell, dependency tracking is all-or-nothing.

**Verify:** observe what happens when a single guard fires in a function that has multiple independent speculations. Everything downstream of the deopt path recompiles from scratch.

---

## SOLUTION

**Move speculation out of the analyses; into the specialization engine as a first-class concern.** Three layers, cleanly separated:

### (S1) Context — a tree of assumptions

A `Context` is a tree node with a parent pointer and one added assumption. Root = `∅` = "assume nothing." A child extends its parent by one assumption like `(nodeId, expected)`.

Tree, not lattice. The operations we need are navigational: extend (O(1)), walk to parent (O(1)), ancestry check (O(depth)). Join, meet, fixpoint iteration — none of these apply. Two arbitrary contexts don't have a meaningful union; "joint observation of A and B" might have never actually happened in any profile run.

Siblings represent independent speculations. A path from root to a leaf is the chain one compiled version depends on.

### (S2) Facts — lattice-valued, indexed by context

Fact store becomes keyed by `(analysis, key, context)`. Each cell runs independent monotone Kildall. No speculation flag on lattice values. No overwrite mode. The original monotone-lattice model the framework was designed for *works again*.

Transforms read only facts under `∅`. The transform API can make this a type-level constraint: no way to pass a non-`∅` context to a transform. The P3 trap becomes unrepresentable.

### (S3) Artifact — the tree of compiled versions

Per function, a tree of compiled versions mirrors its active contexts. Root = unspecialized. Each child = specialized under a chain of assumptions. Guards in compiled code are edges to the parent. Deopt = tree walk up, O(1) per hop. **This is where recovery lives** — the speculation flag in the old model couldn't tell you what to fall back to; the artifact tree can, because each version knows its parent.

### (S4) Context-creation as a pluggable strategy

This is the piece that addresses P4 and that the prior draft omitted. The engine owns a hook:

```
Strategy.onObservation(site, value) → Option<Context>
```

Strategies plug in here:
- **Immediate** (reproduces today's behavior): every observation creates a new context.
- **Count-based**: observation increments a counter; context is created when `count(site, value) ≥ N`. Naive but strictly better than immediate for noisy profiles.
- **Cost-based**: weighed against estimated deopt cost × failure probability.
- **Chain-based**: speculate B only if an ancestor A has persisted past K guard-passes.
- **Composed**: `count AND benefit`, `count OR oracle-hint`, etc.

The key property: strategies are orthogonal to analyses. Adding count-based speculation should touch the strategy module, not `constAnalysis`. The fact that this is currently impossible is the symptom; making it natural is the goal.

### (S5) Mechanics — how an observation becomes a tighter fact

This is the step the rest of the solution hinges on, and it's easy to hand-wave. Explicit version:

1. **Observation arrives at node D.** A strategy inspects it (count, cost-benefit, chain-position, etc.). Decides whether to act.
2. **If yes, create a new context** `C' = parent ∪ {assumption(D, value)}`. The assumption is *frozen into `C'` at creation time* and never modified afterward. Contexts are interned by assumption chain; two independently-derived identical contexts are the same tree node.
3. **Enqueue analyses under `C'`.** Each analysis's cells under `C'` start empty. Its transfer function at D additionally meets its computed in-fact with the assumption:

   ```
   f_D^{C'}(in) = meet(in, assumption_for_D)
   ```

   Everything else is normal Kildall.

**Critically: observations never modify existing cells.** They only create new contexts. If the observation changes later, that's a *different* context. Old contexts retain their computed facts; new contexts start fresh.

**Why this is chaotic-iteration-safe.** The transfer function `f_D^{C'}(in) = meet(in, k)` with `k` fixed is monotone in `in`: if `in1 ⊑ in2`, then `meet(in1, k) ⊑ meet(in2, k)` (basic lattice property — meet preserves order in each argument). So chaotic iteration converges under `C'` to the same fixpoint regardless of block order, just like any Kildall analysis. Concretely on the canonical example (A→B→D, A→C→D, B: x=0, C: x=4) under `C' = {x@D=const(4)}`:

- Order (B, C, D): D.in = meet(join(const(0), const(4)), const(4)) = meet(⊤, const(4)) = const(4).
- Order (D, B, C, D): D.in starts at meet(⊥, const(4)) = ⊥; on revisit, D.in = const(4). Same final state.
- Order (B, D, C, D): D.in transiently = meet(const(0), const(4)) = ⊥; on revisit, D.in = const(4). Same final state.

The key property: this works *precisely because the assumption is immutable for the life of the context*. The current speculative analyses fail this test — they mutate cells in place as observations arrive, which is why they need overwrite mode and unit-wide eviction. Version-by-context instead of mutate-in-place.

**Must-backward fits cleanly under a context.** A must-backward analysis runs on its own cells, under the same context `C'`. From the assumption "x=const(4) at D," it propagates backward: at C.exit → required = const(4) (C's assignment satisfies), at B.exit → required = const(4) (B's assignment `x=0` *contradicts*). The contradiction identifies an infeasible path; the branch becomes the optimal guard placement.

This was impossible in the old model: must-backward would need to write "x=const(4) required at B.exit" into a cell, but that cell is already occupied by may-forward's "x=const(0)." Same cell, conflicting values, no reconciliation possible within a single lattice. Under contexts, must-backward has its own cells under `C'`, independent of may-forward's cells under `C'`. Both are monotone. The engine reads both and uses the contradiction to place guards — it doesn't resolve the contradiction in a cell.

### Problem → Solution mapping

| Problem | Resolution |
|---|---|
| P1. Widening is dead weight | Analysis under `∅` *is* the static analysis; widening no longer needs to exist. |
| P2. Narrowing breaks monotonicity | Per-context cells each run monotone Kildall independently (see S5 for why this is chaotic-safe). Overwrite mode deleted. |
| P3. Transforms can consume speculation | Transforms take only `∅`-keyed facts, enforced by types. |
| P4. No speculation-policy abstraction | Strategies plug into the engine, orthogonal to analyses. Count-based becomes a one-file addition. |
| P5. Coarse invalidation | Invalidating assumption A prunes the subtree rooted at A. Siblings (transforms derived under independent assumptions) survive. |

---

## SPEC (high-level)

Concrete enough to implement against, abstract enough to leave design latitude.

- **`Context`** type: tree node with parent pointer, assumption, interned identity. No joins/meets.
- **Fact store** keyed by `(analysis, key, context)`. Cells independent; each runs the monotone lattice join on writes, as today — just partitioned by context. Seeding a non-`∅` context can use the parent context's facts as the starting point (sound over-approximation).
- **Artifact tree**: per `FunctionUnit`, a tree of compiled versions, each tagged with its context. Guards are edges from child to parent. Runtime dispatch picks the deepest version whose assumptions hold.
- **Strategy interface**: exposes hooks on observation, on guard failure, on call-frequency update. Concrete strategies (count, cost, chained) compose via combinators.
- **Transform interface**: parameterized by context `∅` only. No overload that accepts a non-`∅` context.
- **Deopt**: parent pointer walk in the artifact tree. No full-function recompilation on single guard failure.

This spec deliberately leaves out: the exact `Context` representation, the strategy combinator algebra, the dispatch mechanism. Those are design choices the implementation should make.

---

## Other findings (context, not action items)

Things the review turned up that are *true* but orthogonal to the speculation refactor:

- All four lattices (Type, Const, Purity, Liveness) are algebraically consistent where operations are defined. No law violations.
- `TypeLattice` is a correct product lattice over `(kinds, intRef, boolRef)` with sub-refinements gated on the `kinds` bitmask. Worth appreciating before touching it.
- Three classical DFA quadrants have partial or missing coverage:

  | Quadrant | Classical analogue | Status | Value |
  |---|---|---|---|
  | may-forward | reaching defs / const prop | standard + speculative ✓ | — |
  | must-forward | available expressions / CSE | missing | speculative CSE, hoist expensive computations |
  | may-backward | live variables / DSE | standard exists; speculative missing | profile-driven dead-store elimination |
  | must-backward | very busy / hoisting | missing | **whole-function type specialization from observed return types** — highest-value missing piece |

- `ConstLattice`'s operations are split across `lattice.ts` (join) and `analysis.ts` (meet, leq). Organizational noise.
- `LivenessLattice` is degenerate — all ops return `true`. Sound because absence-from-env acts as ⊥.
- Lambdas are over-approximated in both purity and liveness. Safe, lossy.
- Stmt/expr visitor boilerplate across `constant-folding.ts`, `dead-branch.ts`, `algebraic-simplify.ts`, `dead-store.ts` is heavily duplicated.

None of these are blockers for the speculation refactor. They should be addressed in their own PRs on their own schedules.

---

## Non-negotiable constraints

These derive directly from the problem/solution framing above. A PR that violates any of them is moving in the wrong direction even if it compiles:

1. **No new `speculativeX` analyses.** The pattern is being retired, not extended. New speculative behavior lands as the same analysis running under a non-`∅` context.
2. **No new overwrite-mode fact cells.** Overwrite mode exists only to make P2's hack work within the old model. Per-context cells are monotone; new analyses land in monotone mode.
3. **`Context` threading is not progress on its own.** Introducing the parameter with every caller passing `∅` is type churn with no semantic change. Any PR that introduces `Context` must include at least one caller that passes a non-`∅` value.

Push back if any of these constraints seem wrong — they follow from the thesis, and if the thesis is wrong they're wrong too. But don't route around them silently.

---

## Suggested starting points

Three entry options. They are **not independent** — the constraints above couple (A) to (B).

**(A) Wire speculative liveness — via contexts, not by mirroring.** Smallest quadrant increment. The subtle point: cannot be landed by copying `speculativeTypeAnalysis` (constraint 1). Options: bundle with (B), or land a minimal `Context` scaffold first and express speculative liveness as `livenessAnalysis` under a non-`∅` context. Mirror-and-ship is not an option.

**(B) Introduce `Context` and actually use it.** Foundational. Expect to touch `fact-store.ts`, `dfa-factory.ts`, `dfa-analyses.ts`. Same PR must include a caller passing a non-`∅` context — either by replacing one `speculativeX` with a context-indexed version, or by introducing (A) as the first user. This is the most likely first real PR.

**(C) Prototype must-backward for return-type specialization.** Highest-value long-term. Not a first PR — depends on contexts existing.

**Default recommendation: (B), possibly bundled with (A) as a single PR.** (C) is the prize but shouldn't be first.

Bonus increment, orthogonal but valuable: **introduce a pluggable strategy interface with a count-based policy as the first concrete strategy.** This can land alongside or after (B). The goal is to demonstrate that the policy abstraction works — a count-based strategy should be a single file, no analysis edits required.

---

## Pitfalls

- **Don't embed speculation as a flag on lattice values.** A `{value, speculative}` tagged lattice forgets recovery — a boolean can't tell you what to fall back to. Recovery belongs in the artifact tree.
- **Don't try to compute joins/meets on contexts.** If the design calls for either, something is off. Contexts are tree nodes; operations are navigational.
- **Don't preserve overwrite mode once contexts exist.** It's the workaround for the problem contexts solve. Delete it once per-context cells are live.
- **Don't let transforms consume non-`∅` facts.** Enforce at the type level. If you find yourself adding a runtime check, the API is wrong.
- **Don't design for the full context powerset.** You materialize a small tree of hot contexts. The powerset is a mathematical object you never instantiate.
- **Don't extend `speculativeX` while waiting to delete them.** The set should monotonically shrink from here on.
- **Don't let count-based speculation (or any policy) live inside an analysis.** If a strategy touches `narrowConstObservation`, the abstraction boundary is in the wrong place.

---

## Scope deliberately left open

- **Context-creation policy defaults** (threshold values, decay). The structure should make these pluggable; specific numbers are empirical and defer until there's infrastructure to measure against.
- **Dispatch mechanism** for multi-version artifacts — per-function jump table vs. inline caches. Depends on SVML's call semantics more than on the DFA framework.
- **Closure analysis.** Refining lambda purity/liveness is orthogonal to the speculation refactor. Don't bundle.
- **Transform visitor consolidation.** Worth doing; orthogonal.

---

## How to stress-test this thesis

Before writing code, challenge these load-bearing claims:

- **Is P1 real?** Look at `widenConstObservation`'s call sites. Find one where its output strictly improves on pure static analysis. If you can, the problem framing is wrong.
- **Is the P3 trap real?** Try adding a transform that imports `speculativeConstAnalysis`. Nothing breaks at compile time. Confirmed or falsified in minutes.
- **Is the tree-not-lattice claim right?** Enumerate the operations you'd actually perform on contexts in your design. If any are join/meet, lattice framing wins.
- **Do strategies actually decouple cleanly?** Sketch count-based speculation in the proposed design. If it touches `constAnalysis`, the boundary is still wrong.
- **Does the S5 monotonicity argument actually hold?** The claim is that `f_D^{C'}(in) = meet(in, k)` with `k` fixed is monotone in `in`, so chaotic iteration converges under each context. The proof is a basic lattice property, but verify it against the *actual* lattices in the codebase: ConstLattice, TypeLattice, LivenessLattice. If any of them has a `meet` implementation that isn't monotone in its first argument when the second is fixed, the whole chaotic-safety story for contexts breaks, and the design needs reconsideration (possibly: require lattices to declare meet-monotonicity as a contract).

If the thesis holds up under this scrutiny, the constraints and starting points follow. If it doesn't, push back — you're authoritative over this document when they disagree.
