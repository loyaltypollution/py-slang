# Dream-State Program Analysis Stack for py-slang

## Context

The current `src/specialization/purity-analysis/` flattens four distinct semantic categories into a single 5-point `AbsVal` lattice (`fresh | param | global | closure | impure/unknown`). This conflation produces the `IMPURE_SENTINEL_NODE_ID = -1` hack (effects stored in the value store), over-approximating joins (`fresh(1) ⊔ fresh(2) → Unknown`), and conservative bailouts in `transferCall` (self-recursion and unknown callees always escape args). The only downstream consumer, `transforms/memoization.ts`, queries a single bit (`purityScopePass === true`), yet the infrastructure producing that bit is muddled.

This plan lays out the **academically complete** target: a layered stack where each analysis has a single semantic job, consumes well-typed facts from layers below, and exports a query surface that transforms can use beyond just memoization (inlining, loop-invariant code motion, allocation sinking, specialization dispatch).

**Goal of this document:** establish the reference architecture so that subsequent PRs can land individual layers incrementally, each justified by concrete precision wins over the current design. This is not a single-PR plan.

---

## The Seven-Layer Stack

Ordered bottom-up. Each layer is a distinct `Pass` (or pass family) in the existing `src/specialization/framework/` substrate.

### Layer 0 — Call Graph Construction

**Purpose:** who might call whom? Required for any interprocedural fixpoint.

**Algorithm:** on-the-fly 0-CFA, refined by points-to (Layer 1) as it converges. Start with all `FunctionDef`/`Lambda`/`MultiLambda` nodes as roots; seed call-site targets from syntactic `Variable` callees; refine indirect (`Subscript`, computed) callees using points-to results once available.

**Key space:** `CallSite` = `ExprNS.Call.id`. **Value:** `Set<FunctionDef.id> ∪ {UnknownCallee}`.

**Py-slang specifics:**
- No method dispatch, no inheritance → no CHA/RTA needed.
- Whitelisted builtins (`WHITELISTED_BUILTINS` at `src/specialization/purity-analysis/analysis.ts:54`) are terminal call-graph leaves with known summaries.
- Computed callees (current `transferExpr` defaults to impure) become tractable: points-to on the callee expression yields a set of `Closure(fdId)` abstract values.

**SCC decomposition:** once call graph exists, Tarjan's SCC over the graph produces the order for interprocedural fixpoint in Layers 5–6. Each SCC is analyzed to fixpoint as a unit (all functions in the SCC share optimistic initial summaries, refined monotonically).

**Framework fit:** new `Pass<CallSite, CalleeSet>`. Fact-edge from Layer 1 (points-to) for indirect-call refinement — bidirectional dependency handled via the existing `addEdge` post-hoc registration, same pattern as `purityBlockPass ↔ purityScopePass` (`analysis.ts:500`).

---

### Layer 1 — Points-To / Heap Abstraction

**Purpose:** for every SSA-like local and every abstract heap cell, which allocation sites might it hold?

**Algorithm:** Andersen-style inclusion-based, with these dimensions:
- **Flow-sensitive for locals** (standard). Per-block environments, joined at merges.
- **Flow-insensitive for the heap** (the conventional compromise — flow-sensitive heap is exponential and rarely pays).
- **Field-sensitivity:** py-slang has no attribute access, only `Subscript`. Treat arrays as *index-insensitive* by default (`arr[i]` and `arr[j]` alias within the same allocation site). Optional Phase 2 refinement: constant-index sensitivity when the index is known via `constAnalysisPass`.
- **Context-sensitivity:** object-sensitive is a non-goal here (no objects-as-receivers in py-slang). Start with **context-insensitive** (0-CFA on points-to); upgrade to **1-call-site k-CFA** only if specialization dispatch needs it.

**Abstract locations:**
- `Alloc(nodeId)` — each `List`, `Lambda`, `MultiLambda`, `FunctionDef` node allocation site.
- `Param(fdId, slot)` — opaque parameter cells (bottom of the lattice, may be refined by caller summaries).
- `Global` — single coarse location for all module-level slots (py-slang's module globals are rare and already flagged impure).
- `ExternalEscape` — sink cell representing "passed to unknown code."

**Lattice:** per-slot value is `Set<AbstractLocation>` with a size-cap widening threshold `k` (beyond which, collapse to `AllLocal` or `Escaped` depending on escape status of members). `k = 4` is a reasonable start.

**Why this beats current `fresh(n)`:**
- `let x = cond ? {} : {}` → `Local({n1, n2})`, still unescaped, still safe to mutate.
- Current design collapses this to `Unknown` at the merge and conservatively marks the mutation impure.

**Framework fit:** `Pass<BasicBlock, PointsToBlockFact>` using `makeBlockFixpointPass` (`src/specialization/framework/dfa-factory.ts`). Per-slot lattice is `Set<AbstractLocation>` with custom `leq`/`join`/`equals`. Evicted on unit rebuild via existing lifecycle edges.

**Critical file to create:** `src/specialization/points-to/lattice.ts`, `src/specialization/points-to/analysis.ts`.

---

### Layer 2 — Escape Analysis

**Purpose:** for each abstract location, how far does it escape its allocating function?

**Lattice (three-tier, standard from Choi et al. 1999 / Whaley-Rinard):**
```
NoEscape ⊑ ArgEscape ⊑ GlobalEscape
```
- `NoEscape` — doesn't outlive the allocating frame.
- `ArgEscape` — escapes to the caller (returned, stored into a parameter, captured by a returned closure) but not to globals or unknown code.
- `GlobalEscape` — stored into a global, passed to unknown callee, captured by a `GlobalEscape` closure.

**Derivation from Layer 1:** walk the points-to graph. A location escapes when reachable from:
1. The function's return value set.
2. Any `Global` cell (⇒ `GlobalEscape`).
3. Any parameter's points-to-reachable cell that survives the call (⇒ `ArgEscape`).
4. Arguments to `UnknownCallee` (⇒ `GlobalEscape`).
5. `Capture` edges into closures whose own escape level equals or exceeds this.

**Why `ArgEscape` matters:** enables *caller-side* decisions. The current code at `analysis.ts:241` escapes every Variable arg to every non-pure/non-whitelisted callee. With `ArgEscape` summaries, the caller knows whether the callee actually stored the arg into its own escape set — most don't.

**Framework fit:** `Pass<AbstractLocation, EscapeLevel>`. Lattice: three-point totally ordered.

---

### Layer 3 — Alias Analysis (Derived)

**Purpose:** given slots `x`, `y`, could they point to overlapping memory?

**Derivation (cheap, no separate pass needed):**
- **May-alias:** `pts(x) ∩ pts(y) ≠ ∅`.
- **Must-alias:** both singletons and equal → enables strong updates during analysis.

**Exports a query API, not a pass.** `queryMayAlias(block, slotA, slotB) → bool` and `queryMustAlias(...) → bool` backed by points-to reads.

**Why explicit:** transforms (code motion, CSE) phrase their safety checks in alias terms, not points-to terms. Having a vocabulary layer is worth 20 lines of adapter code.

---

### Layer 4 — Mod/Ref Analysis

**Purpose:** for each function, which abstract locations does it *possibly modify* (`Mod`), and which does it *possibly read* (`Ref`)?

**Computation:**
- Intraprocedural scan over each function body using Layer 1 facts: each `Assign(Subscript)` contributes `pts(container)` to `Mod`; each `Subscript` expression contributes to `Ref`; each Variable read of a capture/global contributes to `Ref`; each Variable write to capture/global contributes to `Mod`.
- Interprocedural closure: walk call graph in reverse topological SCC order. `Mod(f) ⊇ ⋃ Mod(g)` for every `g` that `f` calls, translated through the argument-binding map.
- Inside an SCC: monotone fixpoint with optimistic empty init.

**Py-slang narrowing:** since the only heap-write syntax is `Subscript` assignment, `Mod` is small and tractable.

**Framework fit:** `Pass<FunctionDef.id, { mod: Set<AbstractLocation>; ref: Set<AbstractLocation> }>`. Lattice: pointwise set union.

---

### Layer 5 — Function Summaries

**Purpose:** the interprocedural API between callers and callees. Consolidates Layers 1–4 into a queryable artifact.

**Summary record per `FunctionDef.id`:**
```
{
  paramEscape: EscapeLevel[],      // one per parameter
  mod: Set<AbstractLocation>,       // Layer 4
  ref: Set<AbstractLocation>,       // Layer 4
  returnPointsTo: Set<AbstractLocation>,  // Layer 1 projected to return
  effect: EffectLevel,              // Layer 6
  throws: ExceptionSet,             // Layer 7
}
```

**Fixpoint strategy:** per call-graph SCC, optimistic init (`paramEscape = NoEscape`, `mod = ∅`, `ref = ∅`, `effect = Pure`, `throws = ∅`), iterate until stable. This generalizes the existing `undefined = pending` pattern from `Closure.pure` to all summary axes.

**Pending semantics:** same as current purity — a pending summary is `⊥` in its lattice (maximally optimistic); callers see pending as "deferred, don't taint yet," and the fact-store join naturally refines as the callee converges. Already proven in the closure sub-lattice at `src/specialization/purity-analysis/lattice.ts:40`.

**Framework fit:** `Pass<FunctionDef.id, FunctionSummary>`. Replaces current `purityScopePass` and subsumes it as one axis.

---

### Layer 6 — Effect / Purity Lattice

**Purpose:** the observable-side-effects axis of the function summary. This is what memoization and DCE actually care about.

**Lattice (five-tier, from Reinhard Wilhelm's program analysis textbook and JFP effect-system literature):**
```
Pure ⊑ ReadOnly ⊑ LocalWrite ⊑ ArgWrite ⊑ GlobalWrite
```
- `Pure` — no heap reads, no heap writes. Deterministic on params.
- `ReadOnly` — may read heap (including captures, globals) but writes nothing observable.
- `LocalWrite` — writes only to `NoEscape` locations (i.e., its own fresh allocations). **Observationally pure** — memoization-safe.
- `ArgWrite` — writes through parameters. Safe if caller's aliasing permits; unsafe for global memoization.
- `GlobalWrite` — writes to `GlobalEscape` locations. Unmemoizable.

**Derivation:** compute from Mod (Layer 4) + Escape (Layer 2). For each location in `Mod(f)`, look up its escape level, take the max across all of `Mod(f)`, then project onto the effect lattice.

**Memoization query becomes:** `effect(f) ⊑ LocalWrite` (instead of current `purityScopePass(f) === true`). This is a precision win: functions that allocate-and-mutate-locally before returning become memoizable, where today they're rejected because the per-block DFA widens Fresh→Unknown at any branch merge.

---

### Layer 7 — Exception & Termination Effects (Orthogonal Axis)

**Purpose:** a function is not safe to eliminate-if-unused unless it's known to terminate and not throw.

**Lattice:** `{ mayThrow: Set<ExceptionKind>, mayDiverge: bool }`. Start with `mayDiverge = true` for any function containing a loop or recursive call that isn't provably bounded; refine with simple termination heuristics (for-each over finite collections, `range()` with constant bounds).

**Why orthogonal:** a `LocalWrite`-effect function that diverges is still unsafe to memoize/eliminate. The effect lattice captures *side effects*, not *control effects*.

**Py-slang specifics:** `Assert` stmts throw `AssertionError`; `StmtNS.Raise` throws user-specified. Currently `transferStmt` at `analysis.ts:339` marks `Assert` as `markImpure()` — a category error conflating control and side effects.

**Framework fit:** add to `FunctionSummary`. Mostly a stub in v1 (everything `mayThrow = ⊤`, `mayDiverge = true` unless trivially proven otherwise).

---

## Interaction with the Existing Framework

The `src/specialization/framework/` substrate already has everything needed:

- **Cross-pass fact reads** — each layer reads lower layers via `PassCtx.read`/`tryRead` (`worklist.ts`).
- **Cyclic dependencies** — `addEdge` post-hoc registration handles the Layer 0 ↔ Layer 1 mutual recursion, same pattern as current purity passes (`analysis.ts:500`).
- **Monotone write contract** — `FactStore.write` joins with prior value (`fact-store.ts:40`), which enforces monotone refinement needed for the pending-summary pattern.
- **Lifecycle eviction on rebuild** — `evictStaleBlocks` at `dfa-factory.ts:191` handles incremental invalidation when transforms rewrite the AST.
- **Priority-tiered drain** — runtime passes drain before analysis, and within analysis, natural dependency order emerges from which facts are populated.

**What's missing:** explicit SCC-aware drain for interprocedural passes. The current worklist treats all pass-key pairs as a flat queue; for Layer 5's per-SCC fixpoint to converge efficiently (rather than thrashing across the whole program), the scheduler needs to know "finish SCC X before moving to SCC Y that depends on X."

**Two options:**
1. Add SCC awareness to the worklist's priority function (weight by call-graph topo-depth). Intrusive but clean.
2. Rely on monotone convergence — the current flat worklist will *eventually* reach fixpoint, just with more iterations. Start here; optimize only if profiling warrants.

---

## Downstream Consumer Payoff

The current stack has one consumer (memoization) reading one bit. The layered stack enables:

| Transform | Query |
|---|---|
| Memoization | `effect(f) ⊑ LocalWrite ∧ ¬mayDiverge(f) ∧ mayThrow(f) = ∅` |
| Inlining | `callSiteTargets(cs)` singleton + size heuristic |
| Allocation sinking | `escape(alloc) = NoEscape` |
| Loop-invariant code motion | `¬mayAlias(loopStore, invariantExpr.reads) ∧ effect(invariantExpr) = Pure` |
| Dead store elimination | `¬(store ∈ Ref(futureCode)) ∧ escape(target) ⊑ NoEscape` |
| Specialization dispatch | `pts(callee) singleton` + `paramEscape` compatibility |
| CSE across side effects | `may-alias + Mod/Ref` |

Each of these is blocked today by the flat `AbsVal` over-approximation.

---

## Critical Files — Target Structure

```
src/specialization/
  framework/                   # Unchanged substrate (plus optional SCC-aware drain)
  call-graph/
    analysis.ts                # Layer 0
  points-to/
    lattice.ts                 # Layer 1 — AbstractLocation, PointsToSet
    analysis.ts
  escape-analysis/
    lattice.ts                 # Layer 2 — EscapeLevel three-tier
    analysis.ts
  alias-query.ts               # Layer 3 — derived query API
  mod-ref/
    analysis.ts                # Layer 4
  function-summary/
    summary.ts                 # Layer 5 — record type + SCC fixpoint driver
  effect-analysis/
    lattice.ts                 # Layer 6 — five-tier effect lattice
    analysis.ts
  exception-analysis/
    analysis.ts                # Layer 7
  purity-analysis/             # Becomes a thin adapter returning
                               # `effect(f) ⊑ LocalWrite` for back-compat
```

---

## Precedents & References

- **Andersen 1994** — inclusion-based points-to (Layer 1).
- **Choi, Gupta, Serrano, Sreedhar, Midkiff 1999** — "Escape Analysis for Java" (Layer 2's three-tier lattice).
- **Whaley & Rinard 1999** — compositional pointer/escape analysis with connection graphs.
- **Talpin & Jouvelot 1994** — polymorphic effect systems (Layer 6).
- **Smaragdakis, Bravenboer, Lhoták 2011** — "Pick Your Contexts Well" (context-sensitivity trade-offs).
- **Doop (Bravenboer & Smaragdakis)** and **WALA** — production implementations worth studying.

---

## Out of Scope (Deliberately)

- **Shape analysis** (separation logic, 3-valued logic à la TVLA) — overkill for py-slang's heap model.
- **Full flow-sensitive heap** — exponential, rarely pays.
- **Concurrent-effect tracking** — py-slang is single-threaded.
- **Polymorphic effect inference** (Hindley-Milner-style) — we have node IDs and explicit structure; inference isn't needed.
- **User-facing effect annotations** — the entire stack is internal to specialization.

---

## Verification Strategy

This is a design document, not an implementation plan. Verification applies when each layer is landed individually:

**Per-layer harness:**
- Synthetic test cases that *specifically* exercise the precision win over the current design. E.g., Layer 1's win case: `let x = cond ? [] : []; x[0] = 1` should prove pure (currently proven impure).
- Regression: every test in `purity.test.ts` must still pass with the adapter at `purity-analysis/` delegating to the new stack.
- Cross-layer: points-to results fed into a mock mod/ref should produce known-correct summaries for a hand-computed example.

**End-to-end:**
- Run the full py-slang specialization pipeline (`yarn test`) and confirm memoization fires on all current cases plus the new ones enabled by the refined lattice.
- Benchmark: analysis time on a representative program should not regress by more than 2× in the worst case (points-to is cubic in the abstract; real programs are far sparser).

---

## Incremental Landing Order (suggested)

This is the dream state. Actual PR sequence would likely be:
1. **Layer 1 alone, behind a feature flag**, producing facts that nobody reads yet (shadow mode). Validate precision on test corpus.
2. **Layer 6 + Layer 4**, rewired memoization to consume the new effect verdict. Old `purityScopePass` retired.
3. **Layer 2** — enables the `LocalWrite` tier, unlocking the precision win.
4. **Layer 0 + Layer 5** — proper call graph + summaries, retiring the current per-call-site conservative escaping.
5. **Layer 3 alias API**, once a consumer (e.g., LICM) actually needs it.
6. **Layer 7** — exception/termination — only when a transform demands it.

Each step is justified by a concrete transform win, not academic completeness per se. But the dream-state architecture is the guide.
