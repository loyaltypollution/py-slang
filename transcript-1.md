# Didactic Dialogue: py-slang Specialization Engine (Transcript 1)

**Format**: Newcomer (Q) → Expert (A), single-agent authored, codebase-grounded.

---

## Q1: What is the engines/conductor folder in py-slang?

The `conductor/` folder (`src/conductor/`) is the **evaluator registry** — the bridge layer between the source-academy runner infrastructure and py-slang's interpreter backends. Each file here is an **evaluator class** that implements the `BasicEvaluator` interface from the conductor framework:

- **`PyCseEvaluator{1..4}`** (`PyCseEvaluator.ts`): Plain CSE (closure-substitution evaluator) without any specialization. Parse → analyze (via `analyze(ast, script, variant, groups)` at line 74) → execute. No `Worklist`, no runtime callbacks.
- **`PyCseJitEvaluator{1..4}`** (`PyCseJitEvaluator.ts`): CSE with reactive specialization. Constructs a `Worklist` (line 90), drains the static fixpoint (line 91), wires runtime callbacks (lines 96–104), executes, then drains again to flush deferred CFG rebuilds (line 118).
- **`PySvmlJitEvaluator`** (`PySvmlJitEvaluator.ts`): SVML (stack-based virtual machine language) with JIT specialization. After static drain and compile-time emit, registers a `makeJitPass` (line 50–54) that recompiles and patches functions into the function table during execution.
- **`PySvmlEvaluator`**, **`PySvmlSinterEvaluator`**: One-shot SVML variants (no runtime feedback).

The conductor owns the evaluator lifecycle; at runtime, `evaluateChunk(code: string)` is called per code submission. Key decision: **evaluators instantiate and wire the `Worklist` directly** (SPEC-01 in `optimization-roadmap.md:18`), not through a facade. There is no `SpecializationEngine` object; the framework is bare-metal.

---

## Q2: How does code specialization take place given multiple interpreter backends?

The specialization framework is **interpreter-agnostic**: it lives in `src/specialization/` and works the same for CSE, SVML, and any future backend.

1. **Parse & Resolve**: All evaluators parse and call `analyzeWithEnvironments(ast, script, variant, groups)` to build the symbol table.
2. **Static Specialization**: A `Worklist` is constructed with the AST and function environments. It registers `DEFAULT_PASSES` (`worklist.ts:260–273`): structural discovery, type/const analysis, purity analysis, dead-branch elimination, constant folding, memoization. `drain()` runs these to fixpoint.
3. **Interpreter-Specific Install**: For CSE JIT, memoization AST mutations are installed immediately (mutated `body` is re-read on next CALL). For SVML JIT, a `makeJitPass` is registered *after* construction but *before* execution, so it lives in the pass graph and recompiles + patches on-demand.
4. **Runtime Feedback** (JIT only): As the interpreter executes, two callbacks fire (`observeNodeWrite`, `observeScopeCall` — SPEC-06 in `optimization-roadmap.md:99`). These write facts into the worklist, which dispatches downstream transforms.

The key assumption: the interpreter **re-reads the mutated AST or IR on every CALL** — **Late-Binding Dispatch (LBD)**. The framework doesn't know which backend; it only knows facts live in `FactStore`, passes read/write facts, and the interpreter signals observations.

---

## Q3: Elaborate on the LBD assumption — when does it hold, when does it break?

**Late-Binding Dispatch** means: on every function CALL, the interpreter re-resolves the callee body (or IR) from a **single mutable source**. Load-bearing for safe mid-execution AST mutation (SPEC-07 in `optimization-roadmap.md:121`).

**Holds:**
- **CSE** (`src/engines/cse/interpreter.ts`): every CALL reads `closure.node.body` fresh. Memoization splices a prelude into `fd.body` (`memoization.ts:37`). Next CALL picks up the new array; in-flight frames hold the old array reference and drain cleanly.
- **SVML** (`src/engines/svml/svml-interpreter.ts`): every CALL re-resolves the function-table slot, captures IR **by reference** into `CallFrame.ir`. `patchFunction(index, newIR)` lets in-flight frames continue on old IR; new CALLs pick up the new slot.

**Breaks if an interpreter:**
- **Caches the body** across calls (stores `currentFunc.body` at entry, reuses it) — new code enters expecting old IR.
- **Inlines the IR** into the frame instead of by-reference — mid-flight mutation corrupts frames.
- **Pins functions** and manually checks a "safe-to-mutate" flag — framework tracks no such flag.

Framework "tracks no pin counts, no active-scope set" (`compilation-flow.md:125`). LBD is an **interpreter property** the framework *assumes*. New engines must document how their dispatch shape upholds it.

---

## Q4: How does the specialization engine work internally? Base idea?

A **monotone lattice fixed-point scheduler**. Three primitives (`compilation-flow.md:17–51`):

1. **`Pass<K, V>`** (`src/specialization/framework/pass.ts`):
   - `lattice: Lattice<V>` — `bottom`, `equals`, `join`. `equals` gates dispatch.
   - `reads: Pass[]` — declared dependencies.
   - `transfer(ctx, key) → V | undefined` — pure of upstream facts; `undefined` means no write.
   - `affectedKeys(ctx, triggerPass, triggerKey)` — which keys need re-transfer on upstream change.
   - `tier: "runtime" | "analysis" | "transform"` — drain-order tiebreaker.

2. **`FactStore`** (`fact-store.ts`): `(pass, key) → value` map. `write` joins via `pass.lattice.join`, compares old vs new under `equals`. Equal → no-op, no listener. Different → enqueue all dependents.

3. **`Worklist`** (`worklist.ts`): Priority queue ordered by tier (runtime < analysis < transform), FIFO within tier. `drain()` pops, calls `pass.transfer(ctx, key)`, writes result. Loop until empty.

**Insight**: the lattice's `equals` gate **is** the idempotence mechanism. No `fireOnce` flag, no "has this transform fired" set. Same-value rewrite = no-op. Collapses dirty tracking entirely.

**Example**: `constAnalysisPass` (`const-analysis/analysis.ts:51–63`) is node-keyed. Its `transfer` returns `undefined`; the visitor directly writes via `factStore.write(constAnalysisPass, node.id, widened)` at line 76. `memoizationRule` reads `callCountPass` and `purityScopePass`; when both satisfied, returns `"fired"` (top of `firedLattice`) — triggers AST mutation, bumps `structuralPass`, cascades to JIT recompiler.

---

## Q5: What is the DFA worklist algorithm in general?

**Kildall's algorithm** (1973): fixed-point solver for data-flow analysis over a CFG.

1. Partition CFG into basic blocks.
2. Define lattice `L` and transfer `τ : L → L` per block.
3. Seed entry block's IN to lattice top.
4. Worklist: enqueue all blocks. While non-empty:
   - Dequeue B; compute `B.out = τ(B.in)`, `B.in` = join of predecessor OUTs.
   - For each successor S: `S.in_new = join(S.in, B.out)`. If changed, enqueue S.
5. Iterate to fixpoint.

Terminates given finite-height lattice and monotone `τ`. Order doesn't affect result — only iteration count (reverse postorder is a common heuristic).

Instantiated in py-slang as `makeBlockFixpointPass<L>` (`dfa-factory.ts`). Config supplies `transferBlock`, `top`, `leq`, `join`, `meet`, `seedEnv`. Factory returns a single `Pass<BasicBlock, MutableEnv<L>>` wrapping the Kildall loop inside the `Worklist` scheduler.

---

## Q6: How has it been modified in this codebase specifically?

1. **Multi-Pass Dispatch Graph** (`compilation-flow.md:94–149`): Not one monolithic Kildall loop — *multiple* passes (const, type, purity, memoization) each with own lattice, tied by a fact-driven dispatch graph. When `callCountPass` writes a new count, triggers `memoizationRule`, triggers `structuralPass`, triggers DFA re-runs. **Reactive scheduling.**

2. **Equality-Gated Writes** (SPEC-03, `fact-store.ts:43–67`): `FactStore.write` joins, then gates listeners on `lattice.equals`. No-change writes fire no cascade. Replaces ad-hoc dirty flags (`assumptions.md:76–79`: "replacing the `markDirty`/`flushDirty`/`subscribers` triad").

3. **Tier-Based Drain** (`worklist.ts:24–30, 237–255`): Priority queue with tiers. `drain()` runs runtime → analysis → transform, then flushes pending CFG rebuilds, repeats until no rebuilds.

4. **Strategic Pruning on Rebuild** (`pass.ts:26`, `worklist.ts:166–177`): When `structuralPass` changes, every pass's `prune` is called. Pass returns keys to evict. Strict contract: return only keys of *this unit* (`assumptions.md:22–29`).

5. **Idempotence Under Lattice Equals** (SPEC-05, `assumptions.md:14–20`): Side effects in `transfer` must be no-ops when output equals stored. `memoization.ts:18–39` uses `isAlreadyWrapped` before splicing; JIT pass uses structural IR compare. No imperative fire-once tracking.

The **`pr3-fact-store-refactor`** unified `FactStore` into a single `(pass, key)` map, replacing prior `HintStore` + multiple subscriber registries. Join-on-write eliminated spurious wakes from regressive writes.

---

## Q7: What is the Pass concept?

A **`Pass<K, V>`** is a unit of scheduled computation and the fundamental abstraction (SPEC-02, `optimization-roadmap.md:41`). Unifies what would traditionally be separate interfaces (`AnalysisPass`, `ScopePass`, `TransformRule`, `ScopeTransformRule`). Granularity encoded in `K`:

- **Node-keyed**: `Pass<number, ConstLattice>` — per-node constant facts.
- **Block-keyed**: `Pass<BasicBlock, MutableEnv<L>>` — data-flow analysis.
- **Unit-keyed**: `Pass<FunctionUnit, Fired>` — per-function transforms.
- **Scope-keyed**: `Pass<number, number>` — call counts by FunctionDef.id.

Each has: `lattice`, `reads`, `transfer`, optional `affectedKeys`, optional `tier`, optional `prune`.

**Example**: `constAnalysisPass` (`analysis.ts:51–63`) reads `runtimeWritePass` + `structuralPass`. `transfer` returns `undefined` (writes directly via visitor). `affectedKeys` narrows: if `runtimeWritePass` fires at nodeId X, only nodeId X is affected.

Deliberately minimal. Analyses, codegen, transforms — same shape. Scales from node-level facts to inter-procedural analysis.

---

## Q8: Is this essentially reactive programming / incremental computation? Where does the analogy break?

**Yes, with sharp limits.** Core pattern of reactive/incremental:
- **Dataflow graph** (passes = nodes, `reads` = edges).
- **Push propagation** (write enqueues listeners).
- **Memoization** (unchanged facts don't re-fire).
- **Minimal re-computation** (only affected keys re-transfer).

Algebraic dataflow in the style of Trill, Differential Dataflow, Adapton.

**Where it breaks:**

1. **No incremental AST mutation**: Framework doesn't track *which* nodes changed. `structuralPass` is manually bumped by transforms; DFA factory re-enqueues the entire CFG. No auto-detect.

2. **CFG Rebuild Batches Transforms**: `pendingRebuilds` accumulates (`worklist.ts:43`); CFG rebuilt only after `processQueue` finishes. Reason: `observe` must fire transforms between interpreter steps without invalidating interpreter pointers. Batch-and-rebuild ensures the interpreter doesn't read a partially-rebuilt CFG.

3. **No Subscription/Unsubscription**: Pass graph static post-construction. You can register late (SVML JIT does), but not unregister.

4. **Tier-Based, Not Topological**: Respects tiers + FIFO; no full topo sort. Monotonicity guarantees correctness regardless of order — only iteration count varies.

**Design tension**: true incremental computing aims for O(log N) per change. py-slang pays for CFG rebuilds and full DFA re-runs on structural changes. Tradeoff: simplicity + safety. No pin counts, no active-scope tracking. LBD + lattice monotonicity + batch rebuilds enable safe mutation without that bookkeeping. **Coarse-grained incremental, optimized for interpreter safety, not sub-ms propagation.**

---

## Concept Catalogue (didactic prerequisite order)

1. **Evaluator** (Q1) — backend interpreter (CSE, SVML). Reactive evaluators wire specialization callbacks.
2. **Worklist** (Q4–6) — priority-queue scheduler driving fixed-point over facts.
3. **FactStore** (Q4, Q6) — `(pass, key) → value` map; lattice-joined, equality-gated writes.
4. **Pass** (Q4, Q7) — `Pass<K, V>`: lattice + reads + transfer + optional metadata.
5. **Lattice** (Q4, Q5, Q7) — `(bottom, equals, join)`; monotonicity + idempotence gate.
6. **Late-Binding Dispatch (LBD)** (Q2, Q3) — interpreter's guarantee to re-read body on every CALL.
7. **Data-Flow Analysis (DFA)** (Q5, Q6) — Kildall's block-wise fixed-point, via `makeBlockFixpointPass`.
8. **Structural Pass** (Q4, Q6) — source pass bumped on AST change; triggers CFG rebuild.
9. **Transfer Function** (Q4, Q7) — pure `(ctx, key) → V | undefined`.
10. **Affected Keys** (Q4, Q6, Q7) — narrow re-transfer set; fallback `coarse: true`.
11. **Tier** (Q4, Q6, Q8) — drain-order bucket (runtime < analysis < transform).
12. **Idempotence Under Lattice Equals** (Q4, Q7, SPEC-05) — side effects no-op when output equals stored.
13. **CFG Rebuild Batch** (Q6, Q8) — pending rebuilds flushed post-`processQueue`.
14. **Reactive/Incremental Computation** (Q8) — dataflow-driven re-computation; py-slang is coarse-grained.
15. **Memoization Transform** (Q4, Q8) — wraps hot, pure functions with `__memo_has/get/put` prelude.
16. **Constant Analysis** (Q4, Q7) — node-keyed; drives const-fold + dead-branch.
17. **Purity Analysis** (Q4) — scope-keyed; prerequisite for memoization.
18. **Call Count Analysis** (Q4) — scope-keyed; threshold triggers memoization.
