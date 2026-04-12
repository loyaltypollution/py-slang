# Optimization Architecture: Vision and Open Design Space

This document describes the optimization vision for py-slang. It is meant to
orient LLMs toward the right design space and trigger cumulative brainstorming
on unsettled architectural questions — particularly around how analysis results
flow to consumers.

---

## Core Vision: Background DFA as Incremental Computing Substrate

One DFA worklist algorithm runs continuously in the background, slowly
accumulating annotations across multiple analyses (type narrowing, constant
propagation, etc.). The worklist is the single propagation mechanism — all
analyses share it, all consumers read from it.

The key insight: this will not be a batch "analyze then compile" pipeline. It is an
**incremental computing system** where analysis results trickle in over time and
consumers react to updates at their own pace.

```
                    +------------------+
  push: runtime     |                  |   pull: consumers
  observations ---->|  DFA Worklist    |<---- subscribe to results
  new analyses ---->|  (background)    |
  AST edits ------->|                  |
                    +------------------+
                           |
                    annotations accumulate
                    monotonically on lattices
```

### Push Interface (Settled)

Any source can push work into the worklist:

- **New analysis modules** register transfer functions; the worklist picks them
  up on the next iteration.
- **Runtime observations** (type tags from OBSERVE opcodes, call counts) feed
  back as lattice refinements on variable slots.
- **AST edits** (from transforms like constant folding, dead branch elimination)
  invalidate affected nodes and their dependents.

The push side is well-understood. Each push narrows lattice values; the worklist
propagates until convergence. Monotonicity guarantees termination.

### Pull Interface (Open Design Question)

**This is the central unsettled question.** How do consumers get analysis
results, and how do they learn that results have improved?

---

## Design Space: How Consumers Subscribe to Analysis Results

The following are candidate architectures. None is chosen. Each has different
tradeoffs around latency, complexity, and coupling.

### Option A: Polling with Version Stamps

Each annotation carries a version counter. Consumers poll: "has anything changed
since version N?" If yes, re-read the relevant annotations.

```
Consumer:
  on_tick():
    if hint_store.version > my_last_version:
      new_hints = hint_store.diff_since(my_last_version)
      apply(new_hints)
      my_last_version = hint_store.version
```

- **Pro:** Dead simple. No subscription machinery. Consumer controls when to
  check.
- **Con:** Latency proportional to poll interval. Consumers must implement their
  own diffing logic to figure out what changed.
- **Good for:** Compilers that recompile in bulk at natural pause points.

### Option B: React-Style Subscriptions (Fine-Grained Reactivity)

Consumers subscribe to specific annotation slots. When the DFA refines an
annotation, subscribers are notified. Analogous to React's `useSyncExternalStore`
or Solid's signals.

```
// Consumer subscribes to a specific node's type annotation
const unsubscribe = hintStore.subscribe(nodeId, "type", (oldType, newType) => {
  // recompile just this function / update visualization
});
```

- **Pro:** Minimal recomputation — consumers learn exactly what changed.
- **Con:** Subscription management is complex. Must handle subscription during
  analysis (circular?). Memory pressure from many fine-grained subscriptions.
- **Open question:** What is the subscription granularity? Per-node? Per-function?
  Per-analysis? Too fine wastes memory; too coarse loses the benefit.
- **Good for:** CSE tree-walkers that want live visualization updates.

### Option C: Salsa-Style Query Engine (Demand-Driven Memoization)

Each transfer function becomes a memoized query. Consumers pull results by
calling queries; the engine tracks dependencies and incrementally recomputes
only what changed. See: Rust-Analyzer's Salsa, Adapton.

```
// Query: "what is the type of variable X at statement S?"
fn type_at(var: SlotId, stmt: StmtId) -> TypeLattice {
  // engine memoizes result, tracks that this depends on
  // type_at(var, predecessor(stmt)) and transfer(stmt)
}
```

- **Pro:** Optimal recomputation — only recomputes queries whose inputs changed.
  Handles complex inter-analysis dependencies naturally.
- **Con:** Requires stable node IDs on AST (currently plain objects). Transfer
  functions must be pure and wrapped as queries. Cycle handling (loops, recursion)
  needs special support. Significant infrastructure investment.
- **Open question:** Is the overhead of the query engine justified when we only
  have 2-3 analyses? Salsa pays off at scale. For a small number of forward
  analyses, the worklist might be cheaper.
- **Good for:** IDE-style incremental analysis where edits are frequent and
  re-analysis must be fast.

### Option D: Event Log with Batch Delivery

The DFA writes annotation changes to an append-only log. Consumers drain the log
at their own pace, applying changes in batch.

```
// DFA side
log.append({ node: nodeId, analysis: "type", old: INT|FLOAT, new: INT });

// Consumer side (compiler)
const batch = log.drain_since(my_cursor);
const affected_functions = unique(batch.map(e => enclosing_function(e.node)));
recompile(affected_functions);
```

- **Pro:** Decouples producers and consumers temporally. Consumers can batch
  intelligently (e.g., "recompile only if 5+ functions changed"). Natural for
  async/background analysis.
- **Con:** Log can grow. Consumers must interpret raw events into actionable
  deltas. Ordering and deduplication need care.
- **Open question:** How does a consumer express "I care about type annotations
  on nodes inside function F" without scanning the full log?
- **Good for:** Compilers that want batched recompilation with control over
  "how much change triggers a recompile."

### Option E: Hybrid — Coarse Notifications + Fine-Grained Queries

Combine cheap coarse-grained notifications ("function F's annotations changed")
with on-demand fine-grained queries ("what exactly changed in F?").

```
hintStore.onFunctionDirty(funcId, () => {
  // Coarse notification: something changed in this function
  const hints = hintStore.queryFunction(funcId);
  // Fine-grained read: get current annotations, diff locally
  if (worthRecompiling(hints)) recompile(funcId);
});
```

- **Pro:** Low overhead for the common case (nothing changed). Fine detail
  available on demand. Matches how compilers actually think (function-level
  granularity for compiled backends, node-level for tree-walkers).
- **Con:** Two mechanisms to maintain. "Function dirty" requires tracking which
  nodes belong to which function.
- **Good for:** Mixed consumer ecosystem where compilers want function-level
  batching and tree-walkers want node-level reactivity.

---

## The AST Mutability Problem

**Architectural principle: DFA mutations to the AST must be opt-in for consumers.**

Today's DFA mutates the AST in-place: array splices (dead branch elimination),
child field overwrites (constant folding), and property additions (.hint
stamping). In the AOT model this is fine — DFA runs before consumers start.
In the concurrent model, consumers hold live references into the AST while
DFA is mutating it.

The CSE machine is the most exposed: `Closure.node` permanently stores a
`FunctionDef` reference whose `.body` array can be spliced. `WhileInstr.test`
is re-read on every iteration. `BoolOpInstr.srcNode.right` is read at
execution time, not creation time. All of these break silently if DFA mutates
the referenced nodes.

**This means the pull interface (Options A-E above) is not just about
annotations — it must also mediate structural AST transforms.** Annotations
are monotonic and conservative (a stale hint is safe, just suboptimal).
Structural transforms are not — a spliced-out statement is gone.

See `docs/ast-mutation-hazards.md` for:
- Five classified failure modes (structural shift, identity orphaning, dangling
  reference, mid-expression mutation, annotation flicker)
- Five candidate isolation approaches (snapshot, epoch fencing, mutation log,
  dual-AST, transform deferral)
- A coverage matrix mapping approaches to failure classes

The most promising starting point: **split annotations from transforms.**
Annotations flow freely (safe, monotonic). Structural transforms become
deferred intents that consumers apply when ready. This matches the existing
code structure (`annotateTree()` vs `applyTransformPass()`) and requires the
least new infrastructure.

---

## Consumer Strategies (Also Open)

Different consumers have fundamentally different consumption patterns. The
pull architecture must accommodate all of them.

### Compiled Backends (SVML, WASM)

- **Recompilation is expensive.** A compiler won't recompile after every lattice
  refinement. It needs a strategy for "how much change justifies recompilation?"
- **Batching:** Accumulate annotation changes, then recompile affected functions
  in one pass. The specialization engine decides when to trigger this.
- **Decision strategies to explore:**
  - Threshold-based: recompile when N annotations changed, or when a high-value
    annotation changed (e.g., a hot loop's type narrowed from `INT|FLOAT` to
    `INT`).
  - Epoch-based: recompile at natural pause points (end of REPL entry, between
    program steps in the stepper).
  - Priority-based: hot functions first, cold functions lazily or never.

### Tree-Walking Consumers (CSE Machine)

- **Recomputation is cheap.** The CSE machine interprets one node at a time. It
  can react to annotation changes per-node, per-step.
- **Live visualization opportunity:** As background DFA analysis refines types,
  the CSE machine's visualization could update in real time — showing the user
  that "this variable is now known to be an integer" as the analysis converges.
  This is a novel pedagogical feature: students watch the optimizer think.
- **The hard case:** What if DFA decides to prune a function the CSE machine is
  currently executing (side-effect-free, memoizable result)? The tree-walker
  holds `Closure.node` pointing to that function. With deferred transforms,
  the closure continues executing the old body — the prune intent sits in a
  log until the consumer is ready. Without deferral, the closure's body array
  is spliced out from under it.
- **Architectural questions:**
  - Does the CSE machine read annotations eagerly (check before each node
    evaluation) or lazily (only on subscription notification)?
  - How does the visualization layer learn that an annotation changed? Does it
    poll the hint store, or does the hint store push to a UI event bus?
  - When the CSE machine finishes executing a function marked for pruning,
    how does it signal "I'm done, you can apply the transform now"?

### Future Consumers

- **LSP / IDE integration:** Wants annotation-as-diagnostics. Needs per-file or
  per-function granularity with fast incremental updates after edits.
- **REPL autocompletion:** Wants type annotations at the cursor position.
  Latency-sensitive — must read current best-effort analysis, not wait for
  convergence.

---

## Technical Experiments Worth Running

### Experiment 1: Measure worklist convergence cost

How many worklist iterations does a typical program take? Is re-analyzing the
full program fast enough that incremental infrastructure is unnecessary for
programs under 1000 LOC? If batch re-analysis takes <10ms, the entire
subscription architecture may be premature.

### Experiment 2: Function-level dirty tracking prototype

Implement coarse function-level invalidation: when a transform fires inside
function F, mark F dirty. Measure how often "F is dirty" leads to "F's compiled
output actually changed." If false-positive rate is low, coarse tracking
suffices.

### Experiment 3: OBSERVE opcode for runtime type profiling

Add an SVML opcode that records type tags into a profiling buffer at runtime.
After execution, decode the buffer and feed it back as lattice refinements on
variable slots. This closes the JIT feedback loop: static analysis narrows types,
runtime observation narrows further, re-analysis propagates.

### Experiment 4: Live annotation visualization in CSE stepper

Wire the CSE machine to read `.hint` annotations and display type/const
information in the stepper UI. No subscription system — just eagerly read
annotations before each step. Test whether this is pedagogically valuable before
building reactive infrastructure for it.

### Experiment 5: Subscription overhead microbenchmark

Implement the simplest possible subscription mechanism (Option B, per-function
granularity). Measure memory and CPU overhead for programs with 100, 500, 2000
AST nodes. Determine where fine-grained subscriptions become cheaper than
full re-analysis.

---

## Settled Design Decisions (2026-04-12)

These decisions were reached through discussion and are now load-bearing.
Do not revisit without new evidence.

### Decision 1: Persistent Worklist — Unified Scheduling Primitive

The worklist is the single scheduling primitive for ALL work:

| Work item            | Producer                      | Effect                                              |
|----------------------|-------------------------------|-----------------------------------------------------|
| Analysis fact        | DFA transfer function         | Compute block OUT, propagate to successors           |
| Runtime observation  | Interpreter (via enqueue)     | Write to HintStore, enqueue affected block           |
| Transform            | Analysis crossing threshold   | Mutate AST, update CFG in-place, enqueue neighbors   |

The worklist never "drains to completion." It is a long-lived mailbox that
yields when idle and resumes when new items arrive. Conceptually, the worklist
and the interpreter are separate threads sharing the worklist as a channel —
even though the JS implementation will use cooperative scheduling for now.

**Consequence:** `drainWorklist` (tight synchronous loop) is the wrong
primitive for the persistent model. It becomes a `drain()` method on a
persistent `PersistentWorklist` object that processes available items and
returns when idle.

**Consequence:** `OptimizationSession.step()` / `applyTransforms()` as
separate phases dissolves. Analysis and transforms are interleaved within
the worklist. The session state machine ("ready" / "analyzed") becomes
unnecessary. `OptimizationSession` remains useful as a one-shot convenience
for the non-JIT path (call `converge()` and forget).

**CFG is also persistent.** The worklist references CFG blocks. Transforms
that mutate the AST also update the CFG in-place (add/remove edges, split
blocks). The CFG is not rebuilt from scratch between rounds.

**Open:** Monotonicity of transforms in the unified worklist. Non-monotone
transforms (memoization wrapping adds nodes at ⊥) create temporary precision
dips. See `docs/ast-mutation-hazards.md` Class 6 for analysis and mitigation
options.

### Decision 2: JIT and Non-JIT Evaluators Are Non-Coupled

Two evaluator classes, both extending `BasicEvaluator`:

- `PySvmlEvaluator` — unchanged. Calls `optimize()` (one-shot convergence),
  compiles, executes. No reactive machinery.
- `PySvmlJitEvaluator` — subscribes to `FunctionUnit` changes. When units
  change, recompiles. Interpreter uses a snapshot for each execution cycle.

The downstream code (compile + interpret) is nearly identical in both paths.
The difference is where the units come from: one-shot vs. subscribable.

### Decision 3: No Mid-Execution Mutation

Compiled `SVMLProgram` is an immutable snapshot (`Object.freeze`). The
interpreter holds a reference for the duration of one execution cycle. If
the reactive optimization produces a new version, the interpreter picks it
up on the next cycle — not mid-execution.

Same principle applies to CSE machine: the async generator captures its AST
reference at entry. A new version published by the reactive optimization does
not affect in-flight stepping.

This is enforced by the subscription model: `FunctionUnit` publishes new
versions, consumers subscribe and receive them, but consumers declare when
they are ready to adopt a new version. No push-into-running-interpreter.

`SVMLProgram.withSpecializedFunction(index, newIR)` (already exists in
`types.ts`) is the hot-swap primitive: produces a new frozen program with one
function slot replaced. All existing closures pointing to that index dispatch
to new code on the next CALL (because `call()` reads `this.program.functions`
at call time).

### Decision 4: Memoization Is an AnalysisModule + TransformRule

Memoization detection is not an external profiler signal. It is:
- A `MemoizationAnalysisModule` that reads runtime call-count hints from the
  HintStore (fed by interpreter observations) and detects overlapping
  subproblem patterns above a configurable threshold.
- A `MemoizationTransformRule` that wraps the flagged `FunctionDef` AST with
  cache logic.

Both plug into the existing session machinery via the `AnalysisModule` and
`TransformRule` interfaces. The interpreter's role is limited to feeding
runtime observations (call counts, argument patterns) into the HintStore
via the worklist's enqueue interface.

### Decision 5: Subscription Model for FunctionUnit Consumers

The pull interface follows Option D (Event Log with Batch Delivery) from the
design space above, with function-level granularity:

```
optimize(ast, environments)   → Map<scope, FunctionUnit>   (one-shot, non-JIT)

createReactiveOptimization(ast, environments) → ReactiveOptimization
  .units           → current snapshot (ReadonlyMap)
  .subscribe(cb)   → notified when any unit changes
  .converge()      → run all analyses/transforms to fixpoint (initial pass)
```

Subscribers receive the full unit map on change. Selective recompilation
(only dirty functions) is a future optimization gated on Gap 1: the compiler
currently assigns function indices by DFS traversal order with no
`FunctionDef → functionIndex` lookup table.

### Gaps Identified (Not Blocking, Needed for Full JIT)

**Gap 1: `FunctionDef → functionIndex` mapping.** The SVML compiler assigns
function indices implicitly by DFS order. No lookup table exists. Needed for
`withSpecializedFunction()` to target the right slot. ~5 lines in
`fromFunctionNode()`.

**Gap 2: Interpreter program swap.** `SVMLInterpreter.program` is private
and set at construction. Needs a `replaceProgram()` method or external
mutable reference for the JIT evaluator to swap programs between cycles.

**Gap 3: Persistent worklist implementation.** `drainWorklist` is a
synchronous run-to-completion loop. Needs to become a `drain()` method on
a persistent object with an external `enqueue()` interface.

**Gap 4: CFG mutation API.** `buildCFG` produces a fresh immutable CFG.
Persistent model needs `addEdge`, `removeEdge`, `splitBlock`, `mergeBlock`
on a mutable CFG object.

**Gap 5: `buildFunctionUnits` rebuild.** Called once at compile time. If a
memoization transform adds wrapper functions, the new scopes have no
`FunctionUnit`. Options: (a) memoization inlines cache logic (no new scopes),
(b) re-run `buildFunctionUnits` on modified subtree.

---

## Dead Ends and Traps

Things that were tried or considered and should not be revisited without new
evidence.

- **Single-pass analyze+codegen interleaving.** Incompatible with while-loop
  fixpoint iteration, which revisits loop bodies multiple times during analysis.
  Two-pass (analyze then compile) is permanent.

- **`constructor.name` dispatch.** Breaks under minification (rollup). All AST
  dispatch must use `kind` discriminant fields.

- **Unified Backend interface.** Dissolved — each engine has its own evaluator.
  The abstraction was leaky. Don't re-introduce it.

- **`mergeKind` and `direction` on AnalysisModule.** Dead interface fields. The
  driver hardcodes `join()` and forward traversal. Don't implement dispatch on
  these without a concrete backward-analysis use case.

- **Inter-procedural analysis via call-graph construction.** Unnecessary. Lazy
  memoized function summaries keyed on `(FunctionDef, paramLattices[])` are
  sufficient — the summary cache IS the call graph.
