# Specialization Engine — Architectural Diagnosis

**Subject**: `src/specialization/` (working tree, branch `worktree-pr3-hint-store`)
**Method**: descriptive inventory → roadmap archaeology → falsification prosecution → forensic pattern diagnosis
**Verdict**: **INCOMPLETE, two-to-three patterns stacked**. Not cargo; not one pattern done wrong. Three literature templates partially implemented, each gap filled by hand-written compensation.

---

## 1. The three patterns

### 1a. Truffle — self-optimizing AST interpreter
> Würthinger et al., *Truffle: A Self-Optimizing Runtime System*, SPLASH '12, §3 (Node Rewriting), §4 (Dynamic Compilation).

**What Truffle provides**: per-node specialization, `Assumption` tokens, deoptimization back to a stable form when an assumption is invalidated.
**What we implement**: AST rewriting in place, driven by observation hooks (`observeWrite`, `observeCall`).
**What is absent**: Assumption/deopt. We cannot roll back a rewrite; we can only refuse to apply one.

### 1b. SELF-93 — adaptive recompilation with dispatch-table swap
> Hölzle & Ungar, *A Third-generation SELF Implementation: Reconciling Responsiveness with Performance*, OOPSLA '94, §3.

**What SELF-93 provides**: profile-driven recompile triggers, atomic dispatch-vector patching, safe coexistence of live activations with new versions via direct method pointers in activation records.
**What we implement**: `SVMLSwapStrategy` atomically swaps function-table entries; CallFrames hold direct IR refs (`src/conductor/svml-swap-strategy.ts:44-60`).
**What is absent**: profile-driven triggers. Our triggers come from DFA stability (const-folding, dead-branch elimination), not invocation counters. Memoization is the one exception, and even it couples hotness with a purity check.

### 1c. Kildall — monotone worklist dataflow analysis
> Kildall, *A Unified Approach to Global Program Optimization*, POPL '73.
> Kam & Ullman, *Monotone Data Flow Analysis Frameworks*, Acta Informatica 7 (1977), §2–3.

**What Kildall provides**: per-block IN/OUT environments, monotone transfer functions over a bounded-height lattice, fixpoint via worklist.
**What we implement**: Tier 1 of `PersistentWorklist.tick()` is textbook Kildall — per-block sessions, `mergeKind` join/meet, forward/backward direction, `leq`-based quiescence.
**What is absent** (as Kildall originally framed it): transforms that mutate the CFG, observations that inject values outside the transfer function, non-monotone rules.

---

## 2. Noun-to-pattern mapping

| Pattern | Our implementation |
|---|---|
| **Truffle** (self-optimizing AST) | `ObservationSink` interface; `observeWrite`/`observeCall` hooks; transforms' in-place AST mutation; `InPlaceASTStrategy` (no-op) |
| **SELF-93** (adaptive recompilation) | `OSRCoordinator`; `StateDeltaStrategy<Delta>`; `SVMLSwapStrategy`; `needsInstall` flag; function-table swap |
| **Kildall** (worklist DFA) | `PersistentWorklist` tier-1; `MutableEnv`; `AnalysisModule`; `computeBlockIN`; `transferBlock`; `TypeAnalysisModule`, `ConstAnalysisModule` |
| **Cross-pattern bandaids** | pin-set three-layer gate; `generation` bookkeeping; `rebuildAndReseed`; `MEMOIZED_FIELD` self-latch; `HintStore` registry trio; drain stall-tripwire; `pinSet.clear()` on throw |

---

## 3. The bandaids

Each compensation maps to a specific mechanism an underlying parent pattern would have supplied.

| Compensation | Site(s) | Absent mechanism (from parent pattern) |
|---|---|---|
| Three-layer pin gate: `safeOnStack` + `canInstallOnStack` + `allowOnStack` | `interfaces.ts:67`; `osr.ts:87`; `svml-interpreter.ts:129` | Truffle `Assumption` + deopt |
| `pinSet.clear()` on throw | `engine.ts:105` | Truffle assumption-invalidation semantics |
| Drain stall-tripwire | `persistent-worklist.ts:440` | Rewrite-loop detection under deopt |
| `needsInstall=false` short-circuit | `osr.ts:97, 159` | SELF-93: AST mutation is not a recompile event |
| `generation` bookkeeping (analysis queues) | `persistent-worklist.ts` (throughout) | Profile-timing surrogate under DFA triggers |
| `rebuildAndReseed` / `structuralVersion` | `persistent-worklist.ts:646-655` | Kildall does not model CFG mutation |
| `MEMOIZED_FIELD` self-latch in rule predicate | `transforms/memoization.ts:58` | Kildall does not model non-monotone one-shot rules |
| `HintStore` registry + `LatticeEquality` + `buildRegistry` trio | `framework/hint.ts` (whole file) | Kildall does not model change-notification equality |
| `structuralVersion` on `FunctionUnit` | `framework/function-unit.ts` | Invalidation cue for observers |

The bandaids are **real compensations, not cargo**. Each one addresses a specific gap. The cost is not redundancy — it is that the *union* of three partial patterns requires stitching that no single completed pattern would require.

---

## 4. Consequences on the codebase

Six concrete symptoms of the stacking:

1. **Dead patterns never completed.** `runCFGOptimization` (framework/worklist.ts:302) has **zero callers**. The `stabilizeStatic` + DFA-driver stack (framework/dfa-driver.ts) is tests-only; the production-claim comment at `src/tests/review-findings.test.ts:123` is **stale**. Both are independent Kildall implementations that predate Tier-1 of `PersistentWorklist` and were never removed.

2. **Miscategorized work.** `MemoizationAnalysisModule` implements the Kildall `AnalysisModule` interface but carries no lattice behaviour — `MemoizationVisitor` returns `0` from every visit, and all lattice ops are inert. The real work is `onCallObservation` (SELF-93 profile machinery) plus a one-shot rewrite. It has been forced into a Kildall-shaped slot because the framework offers no better shape. The `MEMOIZED_FIELD` self-latch in `matches()` smuggles non-monotonicity past a fixpoint driver that cannot reason about it.

3. **Infrastructure that exists to do nothing.** `InPlaceASTStrategy` exists because the SELF-93 `StateDeltaStrategy` contract demands a strategy per engine. CSE has no SELF-93-style install step — AST mutation is not a recompile event — so the strategy is a no-op. The coordinator loops, calls the strategy, sees `needsInstall=false`, returns. On every CSE tick, the coordinator is observably inert. It exists only because SVML needs it.

4. **Three-layer pin gate that each layer's author likely thought was "the gate."** `safeOnStack` (rule level, allow-explicit), `canInstallOnStack` (strategy level, deny-by-default via optional-chain at `osr.ts:163`), `allowOnStack` (interpreter-side assertion override, `svml-interpreter.ts:129`). Each gates a distinct concern: AST-mutation safety, install-mechanism safety, live-frame assertion. The reason there are **three** concerns is that none of Truffle's Assumption-based safety is present. With Assumptions, a single gate — "does the assumption still hold?" — would suffice.

5. **Roadmap doc stores its own anxiety.** `docs/optimization-roadmap.md` contains eight distinct groupings of claims that restate the same demand (see Phase 1b SECTION 3 of the audit). Pin-set + finally (4 restatements), ObservationSink collapse (4), strategy + `needsInstall` (4), scope-set notification without diff (4), open-record hint (3), non-cached body getter (4), StmtNS.Visitor completeness (3), fixpoint-before-mutation (3). Repetition at this density is evidence the authors suspected the design was underjustified.

6. **`SpecializationEngine` facade centralizes exactly one real invariant.** `pinSet.clear()` on throw (`engine.ts:105`) is the sole non-trivial thing the class does. Everything else is pass-through (`observationSink` getter, `units` getter, `converge()`, optional-strategy default). The roadmap's SPEC-01 prohibition on direct `PersistentWorklist` construction is asserted without argument; tests freely bypass the facade via `createReactiveOptimization`. The facade hides `installStrategy` ordering but `PySvmlJitEvaluator.ts:27-30` re-documents that ordering in a comment, so callers must reason about it anyway — hiding a constraint callers cannot ignore is anti-signal.

---

## 5. Diagnosis

The subsystem is **three partial patterns layered**: a Kildall tier-1 feeds dataflow-derived triggers into a SELF-93-style installer via Truffle-shaped observation hooks, with the inter-pattern seams hand-stitched.

Two coherent cleanup directions exist:

- **(a) Accept the hand-stitching; remove dead/miscategorized pieces; document the pattern-compensation mapping.** This is what the current adjudication commits to. Net: ≈ −900 LoC with the architectural shape intact.

- **(b) Complete one of the three patterns.** Most plausibly SELF-93 for SVML + Truffle for CSE, retiring the compensating infra. Per-site observation cache replaces `observeValue → lattice` feed; Assumption tokens replace the 3-layer gate; `OneShotScopeRule` marker replaces `MEMOIZED_FIELD` predicate smuggling. This is a future initiative; not a prerequisite.

---

## 6. Where each surviving noun earns its keep

After the Path-(a) cleanup, these remain as genuinely load-bearing:

- `PersistentWorklist` — sole fixpoint engine after α prune.
- `OptimizationHint` — wire format between analyses, transforms, and the SVML compiler.
- `FunctionUnit` — ties AST + hints + slot-lookup per scope (post-γ, no longer owns HintStore).
- `OSRCoordinator`, `StateDeltaStrategy<Delta>`, `InPlaceASTStrategy`, three-layer pin gate — **deferred** because each compensates for an absent mechanism; deletion without replacement regresses. Safe removal requires completing Truffle Assumption semantics.
- `activeScopes` + `withActiveScope` + `runPinned` helper — prevent AST rewrite mid-interpretation. Load-bearing under path (a); dissolved under path (b).
- `isPureFunctionDef` — standalone purity gate; roadmap SPEC-16 endorses this shape explicitly.
- `AnalysisModule`, `MutableEnv`, `buildCFG`, `makeSession`, `computeBlockIN`, `transferBlock` — textbook Kildall substrate; earn their keep by the literature.

The analysis lattices (`TypeLattice`, `ConstLattice`) and the direct transform rules (`ConstantFoldingRule`, `DeadBranchEliminationRule`) were never prosecuted because they are textbook Kildall transforms with no pattern stacking.

---

## 7. Falsified roadmap claims

Items the present audit demonstrates the roadmap overstates or mis-describes:

- **SPEC-07** ("`applyDelta` is *never* called while a frame of the target scope is on the stack") — code has `canInstallOnStack` (strategy-level) and `safeOnStack` (rule-level) opt-ins. "Never" → "default-deny with explicit overrides." The roadmap's own narrative and the code diverge.
- **Class-6 non-monotone scheduler** (roadmap: "out of scope until first such transform lands") — `MemoizationTransformRule` IS such a transform and has already landed. No Class-6 path exists; the rule smuggles through via Class-5 + self-latching predicate.
- **Resolved-gap L701-702** ("no module-level `DEFAULT_REGISTRY` Map; lazy `buildRegistry` helper") — inaccurate. Both shapes coexist: `DEFAULT_REGISTRY_ENTRIES` (array) is the constructor default, and `buildRegistry` runs unconditionally per `HintStore` construction.
- **Gap 4** (incremental CFG mutation: `addEdge`/`removeEdge`/`splitBlock`) — **absent**. `rebuildAndReseed` blows away the CFG and rebuilds from scratch.
- **Gap 5** (`registerScopeSubtree` for memoization-introduced scopes) — **absent**. `addScope` is private; no public entry point exists.
- **Consumer-strategies claim** ("coordinator fires only when a transform actually fires") — **partial**. The coordinator fires on any non-empty changed set, including analysis-induced lattice movement; filtering happens downstream via `needsInstall`/`canInstall`, not at notification time.
