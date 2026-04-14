# Didactic Dialogue: py-slang Specialization Engine — Deep Defence (Transcript 2)

**Format**: Adversarial interrogation. Hostile professor (steeped in PL theory) examines student defending py-slang's "brutalizing well-known algorithms." Grounded in codebase, cites papers, excavates hidden assumptions.

---

## Q1: Soundness of AST Mutation Inside DFA Fixpoint

**PROFESSOR**: Kildall's monotone framework (1973) assumes a **fixed CFG**. You're mutating the AST *during* the fixpoint — transforms fire mid-drain and rebuild the CFG while the worklist is still processing. This is not a classical data-flow analysis. **Prove it terminates.** Or concede you've invented a new semantics and have no soundness guarantees.

**STUDENT**: Fair hit. We do mutate mid-fixpoint. But termination is enforced by three mechanisms:

1. **Tier-based priority** (`worklist.ts:24–30`): Runtime < Analysis < Transform. Transforms fire last.

2. **Idempotence under lattice equals** (`fact-store.ts:43–67`). Every pass has a lattice. Transforms use the `firedLattice` (`transform-rule.ts:9–15`):
   - Bottom: `undefined`
   - Top: `"fired"`
   - Join: absorbing — once `"fired"`, stays fired.
   
   When a transform fires on a unit, it writes `"fired"` to the fact store. The fact store's `write` method (line 54) gates listener dispatch on `lattice.equals(prev, joined)`. If the previous value was `undefined` and we write `"fired"`, that's a change → propagate. If the previous value was `"fired"` and we write `"fired"`, that's no change → no listener wakeup. **The transform never fires twice on the same unit without a structural rebuild.**

3. **Structural rebuild prunes transform state** (`worklist.ts:193–210`). When a transform fires, it bumps `structuralPass` (line 204). The structural-pass change triggers `prune` on all passes (lines 171–177). For memoization, `prune` is intentionally omitted (`memoization.ts:114`), so the `"fired"` fact is **evicted** on rebuild. Next time, it can fire again if conditions re-satisfy.

**The bound**: Each unit can have at most K transforms fire per drain cycle. If unit U fires memoization, that bumps structural, prunes the cell, flushes pending rebuilds. The new structural version cascades to DFA re-runs, which may enable new transforms on *other* units. But memoization on U is blocked until U is rebuilt again.

So the question is: **can a single unit's transforms fire unboundedly?**

Answer: **No, because each transform rule reads a distinct set of upstream passes**, and those passes are monotone. Let me walk the chain:

- `memoizationRule` reads `callCountPass` + `purityScopePass` + `structuralPass`.
- `callCountPass` monotonically increases (capped at saturation `RUNTIME_CALL_COUNT_SAT`).
- `purityScopePass` is binary (true/false/contested) — finite lattice.
- `structuralPass` is a version counter, always increasing.

For memoization to fire again, `structuralPass` must increase (which happens when the rule fired in the first place). So at most one fire per structural version. Structural versions are tied to **CFG rebuilds**. A unit's CFG changes only when its AST changes. How many times can an AST change?

Each transform modifies the AST and bumps structural once. If there are N transform rules, then at most N consecutive fires. After N fires, no transform can fire again (all have already reached their read conditions' maximum lattice height).

**Professor's push-back**: "You're assuming each transform reads a distinct monotone quantity. What if two transforms both write to the same AST and both read an overlapping set of upstream facts?"

**Student concession**: **That's a real gap.** If `constantFoldingRule` and `deadBranchRule` both fire and both mutate the AST, and both read `constAnalysisPass`, then the sequence is:

1. Const-fold fires → bumps structural → prune → const-analysis evicts facts.
2. Dead-branch reads fresh const-analysis facts → fires again.

If const-analysis's lattice is infinite (or very tall), we could oscillate. **But** const-analysis is node-keyed; nodes are created at parse time and only deleted by dead-branch. Once dead-branch evicts a node, that node's const-analysis fact is gone. So dead-branch **strictly decreases** the domain of nodes. After all dead code is eliminated, const-fold has no more opportunities (all remaining code is live, and folding a constant doesn't kill more dead branches). So: **termination holds if structural-pass changes are strictly decreasing in some well-founded measure (e.g., AST size).** Our implementation doesn't prove this mechanically; it's a **disciplinary assumption**.

---

## Q2: Interleaving Analyses and Transforms in One Worklist

**PROFESSOR**: Classical compiler design separates analysis and transformation phases. You run them interleaved in a single worklist. Standard argument: "Monotonicity is enough." Is that actually true? What prevents a transform from firing on **stale** analysis facts?

**STUDENT**: The tier system (`worklist.ts:24–30`). Priority queue orders: runtime (tier 0) < analysis (tier 1) < transform (tier 2). Within each tier, FIFO.

Pseudocode for one drain:
```
while queue non-empty:
  dequeue (pass, key) sorted by tier
  call pass.transfer(ctx, key)
  write result; on change, enqueue listeners
```

So every analysis pass drains completely before any transform wakes. If `constAnalysisPass` writes a new fact on node X, that wakes downstream readers. But `constantFoldingRule` has tier `"transform"`, so even if it's enqueued, it **stays behind** all enqueued analysis items.

Concretely:
1. Drain all runtime passes (e.g., `runtimeWritePass` records observed values).
2. Drain all analysis passes (const, type, purity, call count).
3. Drain all transform passes (constant-fold, dead-branch, memoization).
4. If any transform fired, rebuild CFG and repeat.

Within tier, the worklist uses FIFO + dedup (`pendingKeysByPass`). So if const-analysis on node 42 is enqueued twice, we process it once.

**No stale facts because**: When const-fold fires, it reads `constAnalysisPass` via `ctx.read(...)`, which looks up the current fact store value. The fact store is a live map; we're not snapshotting. If const-analysis updated node 42's fact 50ms ago, const-fold sees that fact now.

**Where it breaks**: If a transform's *side effect* (the AST mutation) depends on global state not captured in lattice facts. Example:

```typescript
// Hypothetical bad transform:
transfer(ctx, unit) {
  const fact = ctx.read(somePass, unit);
  const globalState = this.globallyCachedValue; // DANGER!
  if (globalState.needsRebuild) {
    mutateAST(unit);
    return "fired";
  }
  return undefined;
}
```

Here, the transform's side-effect is a function of both the lattice fact AND global state. If global state flips without the lattice changing, the transform is silently stale.

**Our rule** (stated in `assumptions.md` if it exists, though let me verify):
- Side-effects must be **idempotent** and **deterministic functions of the lattice value alone**.

Looking at `memoization.ts:17–39`: `applyMemoizationWrap` checks `isAlreadyWrapped` (line 21) and returns `false` if already done. This enforces idempotence: the same unit, same AST mutation, always produces the same observable effect. ✓

Const-folding and dead-branch similarly: they inspect the AST and lattice facts, produce new AST, always the same transformation given the same inputs.

**Still, we don't mechanically enforce this.** It's a disciplinary invariant. A rogue transform could violate it and corrupt the system.

---

## Q3: "Equality-Gated Writes as Idempotence" — Sufficient?

**PROFESSOR**: You claim equality-gating solves idempotence (`fact-store.ts:54`). But that only gates **listener dispatch**. A transform's *side-effect* still fires! Even if no listener wakes up.

Look at `memoizationRule.transfer` (`memoization.ts:115–123`):
```typescript
transfer(ctx, key): Fired {
  const fd = key.funcAst;
  if (!(fd instanceof StmtNS.FunctionDef)) return undefined;
  const count = ctx.read(callCountPass, fd.id);
  if (count < MEMOIZATION_THRESHOLD) return undefined;
  if (ctx.read(purityScopePass, fd.id) !== true) return undefined;
  if (!applyMemoizationWrap(key)) return undefined;  // <-- SIDE EFFECT HERE
  return "fired";
}
```

If `applyMemoizationWrap` is called twice with the same unit, it **mutates AST both times**. The second call returns `false` (because `isAlreadyWrapped` checks), but the mutation has already happened. Now, if a downstream analysis was cached and didn't re-run, it's reading stale AST.

**STUDENT**: **You've found a real soundness gap.** Let me be honest. The idempotence property I claimed is **not mechanically guaranteed**. It's enforced by:

1. Each transform manually checking an "already done" condition (`isAlreadyWrapped`).
2. The `firedLattice` preventing re-fire without a structural rebuild.
3. Structural rebuilds pruning transform state.

But you're right: the second call to `applyMemoizationWrap` **does execute** and **does call `fd.body.unshift(...)`** a second time, which is a no-op because `rewriteReturns` has already installed the intrinsic calls.

**Why doesn't it corrupt state?** Because:
- The prelude is identical both times. Prepending an identical statement twice is idempotent for *reading* the body.
- Any downstream analysis that read `fd.body` before the second unshift will... wait, that's the problem.

**Honest answer**: We're relying on the fact that analyses don't **cache** AST properties between transform fires. Each drain cycle, every analysis re-reads the fact store from scratch. The worklist doesn't memoize analysis results across transforms.

Here's the invariant that *actually* holds:

**Invariant: After `flushPendingRebuilds` completes, every pass's facts that depend on the CFG or AST structure are evicted via `prune`. The next drain re-computes them from the new AST.**

So even if memoization mutates twice, the second mutation is idempotent (prepending the same prelude). The next DFA run (triggered by `structuralPass` bump) re-analyzes the mutated AST. There's no *persistent* stale fact.

**But** the idempotence isn't a lattice property; it's an **AST property** enforced by discipline. `isAlreadyWrapped` must be correct, and mutations must be designed to be self-annihilating.

---

## Q4: Runtime Feedback Breaks Monotonicity of Inputs

**PROFESSOR**: Look at `runtimeWritePass` (`runtime-passes.ts:40–51`):
```typescript
export const runtimeWritePass: Pass<number, RawKind> = {
  lattice: rawValueLattice,
  reads: [],
  tier: "runtime",
  coarse: true,
  transfer: undefined, // <-- WRITES VIA OBSERVATION
};
```

And `observeRuntimeWrite` (line 58):
```typescript
function observeRuntimeWrite(observer, nodeId: number, raw: unknown) {
  const prev = observer.factStore.tryRead(runtimeWritePass, nodeId);
  if (prev !== undefined && prev.kind === "unknown") return;
  observer.observe(runtimeWritePass, nodeId, classifyRawValue(raw));
}
```

This records the **actual runtime value** observed at a node. The lattice is `rawValueLattice` (line 34). When a node's value flips (e.g., a branch condition becomes false, then true), what happens?

Observed value: `3` (concrete) → Lattice state: `{kind: "number", value: 3}`.
Observed value: `false` → Lattice state: `{kind: "bool", value: false}`.

The join is `rawJoin(a, b)` (line 25):
```typescript
function rawJoin(a: RawKind, b: RawKind): RawKind {
  if (a.kind === "unknown" || b.kind === "unknown") return RAW_TOP;
  return rawEquals(a, b) ? a : RAW_TOP;
}
```

So: `join({kind: "number", value: 3}, {kind: "bool", value: false})` → `{kind: "unknown"}` (top).

**But what if the program's control flow is data-dependent?** Imagine:
```
if conditionA:
  x = 1
else:
  x = 2
y = x + 1
```

At the second iteration of execution, `conditionA` is false, so `x = 2`. Runtime observation: `{kind: "number", value: 2}`. The fact store joins with previous: `join({kind: "number", value: 1}, {kind: "number", value: 2})` → `{kind: "unknown"}`. Now const-folding can't specialize `y = x + 1`. But if the **first observation wins** (stale), const-folding might wrongly assume `x = 1` always.

This is **fine** if the lattice is monotone: observations only **widen**, never narrow. The lattice is monotone:
- Concrete singleton ⊑ top (unknown).
- The join always goes up.

So no problem there. But you said "observations only widen" — that's true if the program is deterministic. **If the program's behavior changes** (e.g., random choice, I/O, clock), then "observations" are plural executions. The framework assumes observations are *cumulative over the same program instance*, not across rewrites of the program.

**STUDENT**: Exactly. The framework assumes **deterministic programs**, or at least programs where the set of possible values at a node is finite and reachable in a single execution trace.

If a program branches non-deterministically and we observe value A in one execution and value B in another, the framework conservatively widens to top. That's sound; we lose precision but don't specialize unsoundly.

**Where it breaks**: If a program **mutates** in ways that invalidate observations. Example:

```python
def fib(n):
  return fib(n-1) + fib(n-2)

# First call: fib(5) — lots of recursive calls, cold cache.
# Specialization observes: callCount(fib) = 1 (at module level).
# Threshold not met, no memoization.

# Later: fib(10) — now call count increments.
# Second observation: callCount(fib) = 2.
# ...eventually callCount = 11 (saturated).
# Now memoization fires.

# But the first memoization fire mutated the AST!
# Did it invalidate the observations?
```

Answer: **No**, because we're not **re-running the program** after each specialization. The observation (runtime call count) is tied to a particular **execution session**. Specialization (AST mutation) happens after the session ends (or between calls in a REPL session).

The invariant is: **Specialization takes a snapshot of observed facts at a point in time and commits mutations. Future observations are against the mutated AST.**

This is sound if:
1. Observations are **cumulative** (only join upward).
2. AST mutations are **monotonic** (only specialize, never generalize).

Both hold. But it's **not real incremental computation**. Acar et al. (Self-Adjusting Computation, 2006) require fine-grained dependency tracking and can handle programs that recompute portions *without* re-running the whole thing. We're doing something coarser: observe, mutate, re-execute.

---

## Q5: What is the Concretization Function? Where's the Soundness Theorem?

**PROFESSOR**: Abstract interpretation (Cousot & Cousot 1977) defines soundness via a **Galois connection** between concrete and abstract domains. You have lattices (`lattice.ts`), you have `transfer` functions, but:

1. **What's the concrete semantics?** Is it standard Python execution? Then `constAnalysisPass` is abstracting what — the set of values that can flow to a node?

2. **What's the abstraction function α and concretization γ?** For const-analysis, I'd expect:
   - Concrete: set of possible runtime values at a node.
   - Abstract: `{bottom, const(v1), const(v2), ..., top}`.
   - α: {values} → const-lattice. If singleton, `const(v)`. Else, `top`.
   - γ: const-lattice → {values}. If `const(v)`, {v}. Else, anything.

   Prove the connection is sound: `α(S1) ⊑ α(S2) ⟹ γ(α(S1)) ⊆ γ(α(S2))` and commutativity.

3. **Widening and narrowing:** You use saturation (RUNTIME_CALL_COUNT_SAT = 11) to prevent infinite loops. Is this a principled widening strategy or a hack?

**STUDENT**: We have **no formal soundness proof**. This is engineering-over-theory. Let me be honest about what we're doing and what we're *not*.

**What we have:**
- Each pass is defined as a lattice + transfer function.
- The lattice is proven finite and monotone (by construction: join is associative, commutative, idempotent; bottom is the minimum).
- The transfer function is intended to be monotone: if input lattice grows, output grows or stays same.
- The fact store gates on equality, so equal values don't cascade.

**What we don't have:**
- A formal semantics of Python code execution.
- A definition of concretization γ.
- A proof that the transfer function is monotone *relative to* a concrete semantics.
- A proof of the Galois connection.

**Why it works in practice:**
- For `constAnalysisPass`, the "concrete domain" is implicitly "sets of runtime values that can flow to this node in some execution." The abstract domain is the lattice.
- The transfer function (lines 72–97 in `const-analysis/analysis.ts`) is designed to be conservative: if we don't know something, we return `CONST_TOP` (top of lattice). This is the "widening" strategy.
- The soundness argument (informal) is: "Every constant we claim about a node must hold in all possible concrete executions." If we say "node X is always `{kind: "number", value: 42}`," then the observed value must always be 42 or the analysis is wrong.

**Where soundness genuinely holds:** Runtime observations (`runtimeWritePass`) are a **lower bound** on what can flow to a node. If we observe value 42 at a node, then 42 is definitely possible. The join operation is a sound meet-in-the-middle: if we observe {42} in one run and {43} in another, we abstract to {all numbers}, which is correct (and sound).

**Saturation (line 74 in `runtime-passes.ts`):**
```typescript
join: (a, b) => Math.min(RUNTIME_CALL_COUNT_SAT, Math.max(a, b)),
```

This is **widening by threshold**. After 11 calls, we stop counting. It's a heuristic to prevent unbounded loops, not a principled widening in the Cousot sense. It happens to work because: once a function is called 11 times, we assume it's "hot" and memoization is worth it. Whether it's called 11 or 111 times doesn't change the decision.

**Honest assessment**: The system is **sound in practice** but not **proven sound in theory**. It's optimistic specialization with conservative fallback (if memoization breaks, execution falls back to unmemoized code via `observeNodeWrite` in the runtime). But we don't have a mechanical proof.

---

## Q6: Is This Just SAC with Extra Steps?

**PROFESSOR**: Acar, Blelloch, Harper's self-adjusting computation (SAC) framework (2006) does trace-based change propagation. Your system seems to do the same: observe changes, propagate, recompute only affected parts.

Key differences SAC promises:
- **Trace-level granularity**: Every data dependency is tracked at the level of primitive operations.
- **Change propagation**: When an input changes, only affected computations are re-run.
- **Deterministic**: Same program semantics whether running from scratch or incrementally.

Your system:
- **Coarse-grained**: Unit-level (function) granularity, block-level (CFG) at best.
- **Batch rebuilds**: After transforms fire, you rebuild the entire CFG, not incrementally updating it.
- **Non-deterministic** (in a sense): Memoization changes the *program itself*, not just cached values. Two runs — one before memoization, one after — execute different ASTs.

So you're doing **"incremental *specialization*," not incremental *execution*.** SAC is incremental execution (given a fixed program, re-execute cheaply). You're incremental analysis (given observations, specialize the program, then execute it). Are you claiming novelty here, or copying SAC and bolting on AST mutation?

**STUDENT**: We're doing something **fundamentally different** from SAC, and the difference is worth defending.

SAC (Acar et al.) assumes a **fixed program**. Given input changes, it traces dependencies and recomputes only the affected parts. The program code doesn't change; only the *data* changes. Concretely: if you change an input variable's value, SAC traces which computations read that variable and re-runs them. Brilliant, elegant, and proven sound.

**We're doing AST mutation**, which is orthogonal. Our problem is: "Given observed runtime facts, **rewrite the program** to specialize it (e.g., memoize hot functions, fold constants, eliminate dead branches)." SAC doesn't address this.

SAC *could* be applied *after* specialization: once the program is rewritten, use SAC to handle subsequent input changes. But that's a layering.

**Our novelty (if any):**
1. **Reactive specialization**: Specialization can be triggered by runtime observations *during* execution, not just at compile time.
2. **AST mutation under LBD**: We can mutate the AST while the interpreter is running, safely, because the interpreter re-reads the mutated code on every call.
3. **No pin counts, no active-scope tracking**: We avoid SAC's bookkeeping by relying on monotone lattices and equality-gated writes.

**We're not claiming to beat SAC at incremental execution.** If you want sub-millisecond change propagation for pure data-flow, use SAC. We're claiming: "If your program is an interpreter or REPL, you can safely mutate the interpreted source code and specialize it on the fly."

**But** — and here's the honest part — **we pay for coarse granularity**. Each transform fires, rebuilds the CFG, re-analyzes everything. That's O(N) per fire, not O(log N) per change. Differential Dataflow (McSherry et al. 2013) achieves incremental iteration over dataflow graphs; we don't. Their system recomputes only the affected dataflow paths. Ours recomputes everything downstream of a structural change. **We chose simplicity over optimality.**

---

## Q7: LBD as a Contract, Not a Guarantee

**PROFESSOR**: **Late-Binding Dispatch (LBD)** is a contract the framework *assumes* but doesn't enforce. You claim it holds for CSE and SVML interpreters, but what if someone implements a new backend that caches the body?

```typescript
// Hypothetical bad backend:
class BadInterpreter {
  callFunction(closure) {
    const body = closure.node.body;  // <-- Reads ONCE at call-time
    for (const stmt of body) execute(stmt);  // Uses cached body array
    // If body is mutated mid-execution (e.g., in a nested call),
    // we're iterating a stale array. In-flight frames corrupt.
  }
}
```

Or inline-caching without invalidation:

```typescript
// Inline cache that doesn't check for AST changes
class InlineCache {
  lookupAndCache(fd) {
    if (this.cache[fd.id] === undefined) {
      this.cache[fd.id] = fd.body.slice();  // Snapshot
    }
    return this.cache[fd.id];
  }
  // Body mutates, cache is stale, execution is wrong.
}
```

**How does the framework detect or prevent this?** Answer: **It doesn't.** LBD is a property you must *trust* the interpreter to uphold. If an interpreter violates it, the framework silently corrupts execution.

Is this a **soundness bug** or an **expected limitation**?

**STUDENT**: **Expected limitation.** The framework is an **extension to a specific interpreter**, not a language-independent metaprogramming system.

We document LBD as a **precondition** in `compilation-flow.md:121`. New interpreter backends must:
1. Re-read the body (or IR) on every function call.
2. Not snapshot the body into the frame; store by-reference only.
3. Allow in-flight frames to continue on stale IR (e.g., SVML uses `CallFrame.ir` by reference; old frames keep the old IR).

**Can we mechanically enforce this?** Not without instrumenting the interpreter itself — e.g., adding a "version check" on every loop iteration. That's a runtime cost we don't pay.

**What we do have**: `worklist.ts:77–81` — a **synchrony tripwire**:
```typescript
const fn = (this as unknown as Record<string, unknown>)["observe"];
if (typeof fn !== "function" || (fn as Function).constructor.name === "AsyncFunction") {
  throw new Error(`Worklist.observe must be synchronous`);
}
```

This checks that `observe` is not async, preventing race conditions where transform fires happen concurrently with observation. But we don't check LBD.

**Honest assessment**: LBD is a **social contract**. We rely on code review, documentation, and testing to ensure new interpreters respect it. If someone writes an interpreter that violates LBD, we *will* get corrupted execution, and the framework won't catch it. This is a **real limitation** of the approach.

**Mitigation**: Each interpreter backend must have explicit tests verifying LBD. For CSE (`src/engines/cse/interpreter.ts`), we could add a test that:
1. Starts executing a deep recursive function.
2. Mutates the function's body mid-execution (via a side-channel).
3. Verifies in-flight frames still complete correctly.

We don't currently do this, but it's feasible.

---

## Q8: Batch CFG Rebuild vs Incremental Rebuild

**PROFESSOR**: You accumulate `pendingRebuilds` (`worklist.ts:43`) and flush them all at once after `processQueue` drains (`worklist.ts:244`). Why not rebuild incrementally?

```typescript
// What you do (batch):
private flushPendingRebuilds() {
  for (const unit of this.pendingRebuilds) {
    unit.cfg = buildCFG(unit.body);
    // ...
  }
}

// What you could do (incremental):
private onTransformFire(unit) {
  unit.cfg = buildCFG(unit.body);  // Rebuild immediately
  // ...immediately cascade downstream DFA re-runs
}
```

**Differential Dataflow** (McSherry et al. 2013) rebuilds the CFG/IR incrementally and pushes changes through the dataflow graph in real-time. You're batching. **Why?**

Is batching correct, or are you hiding a race condition?

**STUDENT**: Batching is **correct** and **necessary** for interpreter safety. It's not a cop-out; it's the core design decision.

Reason: The interpreter is **iterating over the CFG or IR while transforms are firing.**

CSE example (`src/engines/cse/interpreter.ts`):
```typescript
// Pseudo-code
function execute(node, env) {
  if (node instanceof Call) {
    const closure = evalExpr(callee);
    // NOW: closure.node.body is live in another frame
    for (const stmt of closure.node.body) {  // <-- Iteration pointer
      execute(stmt, env);  // <-- May trigger observe(), may queue transform
    }
  }
}
```

If we rebuild the CFG mid-iteration (before the for-loop completes), the iteration pointer is now pointing into a stale or partially-valid CFG.

**Batching solves this**: We queue transform-fires into `pendingRebuilds` but **don't rebuild yet**. The interpreter finishes its current `execute` call (the for-loop completes). Then, at the outermost level, `endBatch()` is called (or `drain()` is called after `processQueue`), and *then* we flush rebuilds.

This ensures: **no CFG rebuild happens while the interpreter is in the middle of iterating over the CFG.**

**Differential dataflow assumes a different execution model**: The dataflow itself is the computation. There's no separate "interpreter" iterating over it. Changes to the dataflow graph are applied before the next round of dataflow computation.

We have a **interpreter + specialization system** two-level hierarchy. The interpreter is the "driver." Specialization is a side effect of interpretation. Batching respects the interpreter's control flow.

**Race condition possibility**: If two concurrent threads call `observe` and both queue transforms, could both fires happen before a batch starts? Yes, if `batchDepth > 1`. But we have synchrony enforcement (`worklist.ts:77–81`), so observation is always synchronous within a single-threaded interpreter session. Nested batches are allowed (re-entrant); only the outermost `endBatch` flushes.

**Is batching complete?** We flush all pending rebuilds after a `processQueue` drains. But `processQueue` can enqueue new transforms (via cascading listeners). So we loop: `drain(limit=Infinity)` (line 237) runs `processQueue()` and `flushPendingRebuilds()` in a while loop until no rebuilds are pending.

---

## Q9: Termination Under Cascading Transforms

**PROFESSOR**: Let me trace a sequence:

1. Runtime observes `callCount(fib) = 10`.
2. `runtimeCallPass` writes 10.
3. `callCountPass` reads 10, writes 10.
4. `memoizationRule` reads callCount=10, purity=true, writes "fired".
5. Structural pass bumped, CFG rebuilt.
6. `constAnalysisPass` re-runs on new AST (now with memoization prelude).
7. New const facts discovered (e.g., memoization's string key is constant).
8. `constantFoldingRule` fires, mutates more AST.
9. Structural pass bumped again, CFG rebuilt.
10. `deadBranchRule` re-analyzes...

**How many iterations can this go for?** Is there a proof that the worklist `drain(limit=Infinity)` will actually terminate, not spiral?

**STUDENT**: This is the most serious question you've asked. Let me work through it carefully.

**Termination is guaranteed by a well-founded measure:**

Define a potential function Φ over the system state:
```
Φ = (S, P, R)

where:
  S = set of distinct AST nodes in the program
  P = sum over all passes p of the size of factStore[p]
  R = number of pending rebuilds
```

**Claim**: Φ strictly decreases with each transform fire (and eventually stabilizes when no transforms fire).

**Proof sketch:**

1. **Constant-folding decreases S**: Const-folding replaces `1 + 2` with `3`. The new AST is strictly smaller (one node instead of three). S decreases.

2. **Dead-branch elimination decreases S**: Dead-branch removes nodes (entire if-branches). S strictly decreases.

3. **Memoization doesn't increase S much**: Memoization wraps a function body in a prelude. This adds nodes, but it's one-time — once wrapped, subsequent memoization fires see `isAlreadyWrapped` return true and don't fire again. After the first fire, memoization's `prune` doesn't evict the "fired" cell; it stays (because no `prune` function is defined in `memoization.ts:114`). So memoization fires at most once per structural version.

But wait — structural versions increase on every rebuild. Can structural versions increase unboundedly?

**Counter-claim**: Structural versions are tied to **CFG rebuilds**, not AST mutations. Rebuilds are queued in `pendingRebuilds` and flushed once per drain cycle. Each flush happens because a transform fired. If S (AST size) strictly decreases (due to const-fold and dead-branch), and memoization fires at most once per rebuild, then: **the number of rebuilds is bounded by the number of distinct memoization and dead-branch opportunities.**

Dead-branch can fire at most O(N) times (once per node). Const-fold can fire at most O(N) times (once per node). Memoization can fire at most O(M) times (once per function). So: **at most O(N + M) fires, meaning at most O(N + M) rebuilds.**

So `drain(limit=Infinity)` is safe; it will terminate.

**But** this assumes dead-branch strictly decreases S and fires deterministically. If dead-branch can enable more const-folding (because const-analysis now sees a larger constant sub-expression), and const-folding enables more dead-branch, we could oscillate.

**Reality check**: In practice, dead-branch eliminates unreachable code (e.g., branches after `return`). Const-analysis discovers constant values. These don't interact tightly — dead-branch doesn't become "more enabled" as const-analysis refines. And const-folding, once done, doesn't undo; it replaces expressions with literals. So oscillation isn't likely.

**But** — honest gap — **we don't have a formal proof of this.** We're relying on:
1. Lattices are monotone (by construction).
2. Transforms are idempotent (by discipline: `isAlreadyWrapped`, etc.).
3. AST size strictly decreases (by design of dead-branch and const-fold).

If someone writes a transform that oscillates (e.g., a transform that toggles a flag based on some condition), and that condition flips based on other transforms' effects, we could hang. We don't have a mechanism to detect this. The `limit` parameter in `drain(limit=Infinity)` is unused (defaults to Infinity).

**Improvement**: We could add a limit and a warning: "Specialization worklist exceeded 1000 iterations; possible non-terminating transform cycle."

---

## Q10: Absence of Topological Sort and Monotonicity Claims

**PROFESSOR**: In classical dataflow analysis (Kildall 1973), you impose a topological order on the CFG (often reverse postorder) to reduce iteration count. Here, you rely on **monotonicity alone**: "Order doesn't affect correctness, only iteration count."

But you have **transforms**, which are not pure lattice functions. Transforms **mutate the AST**. Claim: Monotonicity alone is sufficient, and you don't need a topological sort.

**Prove it.** Or concede that tiers + FIFO is a hack that happens to work empirically.

**STUDENT**: Fair challenge. Let me carefully separate the invariants.

**Theorem (monotonicity suffices for correctness):**
> If every pass's `transfer` function is monotone (output ⊒ bottom whenever input changes) and the lattice is finite, then the worklist reaches a fixed point regardless of firing order.

**Proof**: Lattice theory. Each cell `(pass, key)` has a value in a finite-height lattice. Write operations join values, which is monotone. Once a cell reaches a top value (in its local lattice), it stays there. No regressive writes. By the ascending-chain property, after finitely many writes, every cell stabilizes. No order dependence.

**This applies to pure analysis passes.** But transforms are *not* pure lattice functions; they have **side effects** (AST mutations).

**Transforms use the `firedLattice`:**
- Bottom: `undefined`.
- Top: `"fired"`.
- Join: absorbing.

So the *lattice* is monotone. But the *side effect* (AST mutation) breaks monotone's sufficiency guarantee because:

1. Const-analysis fires (reads const facts, computes node values).
2. Const-folding fires (mutates AST, bumps structural, prunes const-analysis facts).
3. Now const-analysis re-runs.

The re-run might produce different results *on the new AST*. The old const-analysis facts are evicted (via `prune`), so const-analysis can fire again. This is fine; const-analysis is monotone locally.

But **transforms are not independent**. If const-folding and dead-branch both mutate the AST, the order matters for *efficiency* (and for correctness, if one transform's side effect affects another's precondition).

**Example**: Suppose const-folding folds `if 1 + 2 == 3:` to `if true:`. Then dead-branch should eliminate the false branch. If dead-branch fires *before* const-folding, it can't see the folded condition, so it keeps both branches. Ordering matters.

Our worklist enforces: **all analysis passes before all transform passes** (via tiers). This ensures:
- All const-analysis facts are finalized before const-folding reads them.
- Once const-folding fires and mutates, const-analysis is evicted; the next drain cycle re-runs it from scratch.

**Is this sufficient?** Only if transforms can be ordered: const-fold before dead-branch. We don't enforce a topological sort on transforms. They're both tier "transform", so they're FIFO. If dead-branch enqueus before const-fold (by chance of the worklist order), dead-branch fires first and misses const-folding opportunities.

**But** — and this is the key — **we don't claim optimality.** We claim *correctness*: the final fixpoint is a valid specialization, even if it's not the most optimized one.

Here's the more precise claim:

**Invariant (Eventual Completeness):**
> After `drain(limit=Infinity)` terminates, all firing conditions that were satisfiable remain satisfied (or become unsatisfiable due to structural changes). No transform is "stuck" waiting for a fact that will never arrive.

This holds because:
1. Tiers ensure analyses finish before transforms.
2. Monotone lattices ensure facts only grow (or stay stable).
3. Equality-gating ensures no spurious re-fires.
4. Rebuilds evict stale facts and allow transforms to fire on fresh data.

**Is this a "hack that happens to work"?** Partly. The tier system is a **pragmatic guarantee** of a partial order, not a full topological sort. We're trading precision (better ordering) for simplicity (tier-based batching). This is an engineering decision, not a theoretical flaw.

---

## Q11: Relationship of "Monotonicity of Transforms" to Lattice Join

**PROFESSOR**: You claim transforms are idempotent under `firedLattice.equals`. Let's examine this closely.

`memoizationRule` reads:
- `callCountPass` (lattice: numbers 0–11).
- `purityScopePass` (lattice: bool | "contested" | undefined).
- `structuralPass` (lattice: version numbers).

All monotone. The rule fires if:
- callCount ≥ threshold.
- purity = true.
- AST hasn't been wrapped yet.

Once fired, the rule writes `"fired"` to `firedLattice`. The fact store compares old vs new under `firedLattice.equals`: `(a, b) => a === b`. So `undefined` vs `"fired"` is a change, and listeners wake. But `"fired"` vs `"fired"` is no change.

**Here's the trap**: What if the rule's *preconditions* re-enable after a rebuild? Concretely:

1. First iteration: callCount=5, threshold=10. Rule doesn't fire (precondition false).
2. Later iteration: callCount=11 (saturated). Purity=true. Structural bumped (new version).
3. Second iteration: Rule evaluates preconditions again. callCount=11, purity=true, structuralPass version is new.
4. Rule fires, writes "fired".

But wait — the second time, the rule is reading `structuralPass` from the context. Its *value* (the version number) has increased. But the rule's `reads` list includes `structuralPass` — does reading it re-enable the rule?

Let me look at `memoizationRule.affectedKeys` (`memoization.ts:106–113`):
```typescript
affectedKeys(ctx, triggerPass, triggerKey) {
  if (triggerPass === (structuralPass as Pass<any, any>)) {
    return [triggerKey as FunctionUnit];
  }
  const fdId = triggerKey as number;
  const unit = ctx.unitForFdId(fdId);
  return unit === undefined ? [] : [unit];
}
```

So when `structuralPass` writes a new version, `memoizationRule` is enqueued with the unit as the key.

The rule's `transfer` runs again. Preconditions are re-checked. If they're now satisfied, the rule writes `"fired"` again. But wait — on the *second* rebuild, the previous value was `"fired"`. The new value is... `"fired"`. So `firedLattice.equals("fired", "fired")` → true, no change → no listener cascade.

**So the rule fires but doesn't cascade.** That's fine; no wakeup of downstream passes.

But the rule *did* call `applyMemoizationWrap` again. Line 121: `if (!applyMemoizationWrap(key)) return undefined;`. The function checks `isAlreadyWrapped` and returns false if already wrapped, preventing the second mutation.

**So** — no second mutation, no corruption. The rule's side-effect is idempotent: the second fire attempts the same mutation but the guard prevents it.

**My question**: Is this idempotence **guaranteed by the lattice**, or **guaranteed by the guard**? If the guard (`isAlreadyWrapped`) is wrong, could we corrupt state?

**STUDENT**: **Guaranteed by the guard, not the lattice.**

The lattice (`firedLattice`) ensures the rule is **only called once per structural version** (no re-fire without a rebuild + prune). But the lattice doesn't prevent the rule from being called a second time *on the rebuilt AST*. It's `isAlreadyWrapped` that prevents the second mutation.

If `isAlreadyWrapped` is buggy (e.g., doesn't actually detect the prelude correctly), we could wrap twice, corrupting the function.

**Current implementation** (`memoization.ts:41–49`):
```typescript
function isAlreadyWrapped(body: StmtNS.Stmt[]): boolean {
  if (body.length === 0) return false;
  const first = body[0];
  if (!(first instanceof StmtNS.If)) return false;
  const cond = first.condition;
  if (!(cond instanceof ExprNS.Call)) return false;
  const callee = cond.callee;
  return callee instanceof ExprNS.Variable && callee.name.lexeme === MEMO_HAS;
}
```

This checks: is the first statement an if? Is the condition a call to `__memo_has`? If yes, assumed wrapped.

**Potential bug**: If user code happens to start with `if __memo_has(...)`, the rule thinks it's wrapped and skips. But user code would be *very* suspicious. We're relying on the assumption that programs don't naturally start with a memo-has check.

**Better implementation**: Use a marker node (`node.id === MEMOIZATION_MARKER_ID`) to prove it's *our* code, not coincidental user code. Currently, we don't.

**Honest assessment**: We're relying on a heuristic guard, not a lattice-level guarantee. If the guard is wrong, the system breaks. This is a **real, though unlikely, bug.**

---

## Q12: How Concrete is the "Coarse-Grained Incremental" Claim?

**PROFESSOR**: You say you're "coarse-grained incremental" — functional level, not instruction level. But what does incremental *mean* exactly?

1. **Does changing an input re-run the program, or re-specialize it?**
2. **Can you handle two consecutive program executions and incrementally specialize between them, or must you re-analyze from scratch?**
3. **What's the incremental unit — a function, a pass, a block?**

SAC guarantees: Given input change Δ, re-execute in O(affected-trace-size). You don't have that.

Differential dataflow guarantees: Given dataflow change, propagate in O(log N) rounds. You don't have that.

**What do you guarantee?** Articulate it precisely.

**STUDENT**: Fair question. Let me define what we actually do:

**Incremental Specialization** (our contribution):
> Given a program P and a sequence of runtime observations O₁, O₂, ... (from executions), specialize P based on O₁ ∪ O₂ ∪ ... such that:
>
> 1. Observations only join upward (monotone).
> 2. Specializations (AST mutations) only accumulate (once memoized, stays memoized).
> 3. Between executions, the specialization worklist is drained to fixpoint.
> 4. The specialized program is deterministic: given the same inputs, same outputs (before and after specialization).

**What we *don't* guarantee**:
- Incremental *execution* (SAC's promise).
- Sub-linear re-analysis (differential dataflow's promise).
- Incremental updates to the CFG (we rebuild completely).

**Incremental unit**: We specialize at the **function level** (memoization) and **block level** (DFA). But CFG rebuilds are coarse: `buildCFG(unit.body)` re-builds the entire unit's CFG.

**Incrementality measure**: If a transform fires on unit U, we:
1. Evict U's analysis facts (via `prune`).
2. Rebuild U's CFG.
3. Re-run U's analyses.
4. Check if downstream units are affected (no automatic propagation; we rely on pass-graph listeners).

So: **O(|U|) cost per transform on U**, where |U| is the function size. If U is 100 lines and 50 functions call U, we don't automatically re-specialize the 50 callers. They continue using the old memoization cache until they're re-analyzed (which happens only if their own observed facts change).

This is **not incremental in the SAC sense** (which would mark those 50 callers as "affected" and re-run them). We're **incremental in the sense that we batch transforms and avoid re-analyzing unchanged code.**

**Example**:
```python
def hot_func():
  return compute()

def call_many_times():
  for i in range(1000):
    hot_func()

# Observations: call_many_times called 1 time, hot_func called 1000 times.
# Specialization: Memoize hot_func.
# CFG rebuilt: hot_func's CFG only.
# Cost: O(|hot_func|).

# If call_many_times' implementation changes (new branch),
# and that new branch calls hot_func differently, we don't auto-detect.
# Incrementality stops at the function boundary.
```

**Honest statement**: **We're not actually incremental in a strong theoretical sense.** We're "reactive" (observations trigger specialization) and "batched" (transforms are batched per drain cycle). But "incremental" might oversell us.

---

## Q13: Relationship to Polymorphic Inline Caches and Tracing JITs

**PROFESSOR**: SELF (Chambers et al. 1991) pioneered polymorphic inline caches (PICs), and modern tracing JITs (TraceMonkey, LuaJIT) specialize code at runtime based on observed types and values.

How is py-slang's specialization different from, say, TraceMonkey's strategy: record a hot trace, specialize it, re-enter the trace on matching inputs?

**STUDENT**: Key differences:

**TraceMonkey (Gal et al., PLDI 2009) / LuaJIT approach:**
1. **Trace recording**: Record a linear trace through a hot loop (ignoring branches).
2. **Specialization**: Compile the trace to native code, add type guards.
3. **De-optimization**: If a guard fails (e.g., type changes), exit to interpreter.

This is **type-driven specialization**: the trace captures a specific type configuration. If types stay the same, run native code (fast). If types change, deopt and re-interpret.

**py-slang approach:**
1. **Value-driven observation**: Record observed runtime values (not types; actual constants).
2. **AST mutation**: Rewrite the source AST (not compile to native code).
3. **Fall-back**: Memoized code falls back to interpreter via intrinsic calls.

**Similarities**:
- Both observe runtime behavior.
- Both specialize based on observations.
- Both are "optimistic" — assume observed values will repeat.

**Differences**:
1. **Target**: TraceMonkey → native code. py-slang → source AST.
2. **Type vs Value**: TraceMonkey guards on types. py-slang guards on values (constants).
3. **Deopt**: TraceMonkey's deopt is aggressive (exit to interpreter on type mismatch). py-slang's fallback is conservative (the fallback code is still in the rewritten AST).

Example:
```python
def fib(n):
  return fib(n-1) + fib(n-2)  # Recursive

# TraceMonkey: Record a trace of fib(5), compile to native, add type guard "n is int".
# If fib(5.5) is called, deopt and interpret.

# py-slang: Observe fib(5), memoize the function.
# If fib(5.5) is called, the memo lookup fails (5.5 not in cache), falls through to compute.
```

**Novelty (if any)**: py-slang is doing **specialization at the AST level**, not the bytecode/native level. This allows fine-grained source rewrites (memoization, constant folding). Tracing JITs work at the IR/native level, which is less flexible but much faster.

**Trade-off**: py-slang gains source-level flexibility but pays interpreter overhead. A tracing JIT gains speed but loses source introspection.

---

## Q14: Deopt as Fallback, Not Guarantor

**PROFESSOR**: You claim memoization "falls back" to interpreter code if the memo lookup fails. But what is the semantics of a memoization failure? Does the program still produce correct results?

```python
def expensive(x, y):
  return x + y

def use_expensive():
  a = expensive(1, 2)
  b = expensive(1, 2)  # Should hit memo cache
  c = expensive(1, 3)  # Cache miss, recompute
```

After memoization, the AST looks (roughly):
```python
def expensive(x, y):
  memo_id = "expensive@L42"
  if __memo_has(memo_id, x, y):
    return __memo_get(memo_id, x, y)
  result = x + y
  return __memo_put(memo_id, x, y, result)
```

**Question**: If `__memo_put` or `__memo_get` crashes, does the original computation still run, or do we lose the result?

**STUDENT**: Good catch. Let me trace the control flow:

```python
if __memo_has(memo_id, x, y):
  return __memo_get(memo_id, x, y)  # Early exit; original code doesn't run.
else:
  # Fall through to original code
  result = x + y
  return __memo_put(memo_id, x, y, result)
```

So:
- **Cache hit**: Early return via `__memo_get`. Original code never runs. If `__memo_get` crashes, the function crashes.
- **Cache miss**: Original code runs, result is wrapped with `__memo_put` before returning.

**Correctness guarantee**: If the original code is pure (no side effects), the memoization is semantically equivalent. The memoized version produces the same result for the same inputs, just from a cache if available.

**If the original code has side effects** (e.g., prints, modifies global state), memoization changes semantics:
```python
def side_effect(x):
  print(f"Computing {x}")  # Side effect
  return x * 2

# Original: side_effect(5) prints every time.
# Memoized: side_effect(5) prints once, then serves from cache without printing.
```

This is why `purityScopePass` checks whether the function is pure before memoizing. If `purity = true`, memoization is sound. If `purity = false`, memoization is skipped. So we **don't** memoize side-effecting functions.

**What if the purity analysis is wrong?** Suppose `purityScopePass` says true (pure), but the function actually has a side effect (e.g., calls a function that modifies global state, which purity analysis missed). Then memoization violates semantics.

**This is why the system is "optimistic"**: We speculate on purity. If the speculation is wrong, execution is wrong. We don't have a runtime guard to check purity (e.g., a side-effect detector). We rely on the analysis being sound.

**Concretely**, if the runtime observed that a function was called 11+ times and `purityScopePass` claims it's pure, but it's actually impure, the memoized version will have **incorrect semantics** (fewer side effects than the original). There's no automatic fallback to undo memoization.

This is a **real soundness gap**: if the purity analysis is unsound, the system produces wrong results, silently.

---

## Q15: Where's the Mechanically Enforceable Guarantee?

**PROFESSOR**: Let me summarize the gaps we've found:

1. **Soundness of AST mutation under DFA**: Claimed termination, but no proof. Relying on discipline.
2. **Idempotence of transforms**: Guarded by `isAlreadyWrapped`, not by the lattice. Heuristic-based.
3. **LBD as a framework assumption**: Not enforced. Social contract only.
4. **Purity analysis soundness**: Speculative. If wrong, silent semantic corruption.
5. **Monotonicity of runtime observations**: Assumes determinism or benign non-determinism.
6. **No formal proof of soundness**: Only informal invariants.

**How many of these would a commercial JIT allow?** Zero. TraceMonkey has runtime guards (type checks, range guards). You have heuristics and hope.

**Where does the framework actually enforce correctness mechanically?**

**STUDENT**: **Only two places:**

1. **Lattice monotonicity and equality-gating** (`fact-store.ts`): Writes are joined, not overwritten. Listeners fire only on change. This is mechanical — the code proves it.

2. **Tier-based scheduling** (`worklist.ts:24–30`): Analyses drain before transforms. This is mechanical — the priority queue enforces it.

**Everything else is enforced by discipline:**
- Interpreters must uphold LBD (code review, testing).
- Transforms must be idempotent (guard checks, but not mechanically verified).
- Analyses must be monotone (design discipline, not runtime checking).
- Purity analysis must be sound (testing against real code).

**Where we could add mechanical enforcement:**

1. **Idempotence marker**: Wrap every transform's AST mutation in a marker (`node.id = MEMOIZATION_PRELUDE_V1`) instead of checking for a specific pattern. Cost: extra bookkeeping.

2. **LBD instrumentation**: Add a version check inside the loop: `assert(node.version === capturedVersion)` before each statement. Cost: per-statement overhead.

3. **Purity verification**: Add a runtime side-effect detector (log all function calls, check against a whitelist). Cost: interpreter overhead.

4. **Lattice verification**: Use a theorem prover to verify that transfer functions are monotone. Cost: user burden.

None of these are implemented. We've chosen to rely on discipline, testing, and code review.

**Honest assessment**: **The system is sound in practice, not in theory.** Production systems (V8, SpiderMonkey, LuaJIT) invest heavily in mechanical guarantees: type guards, runtime checks, deopt. We don't. This is a deliberate trade-off: we prioritize **simplicity and readability** over **iron-clad guarantees**.

---

## Committee Verdict

### What Holds Up

1. **Lattice-monotone fact propagation**: The fact store's join-on-write and equality-gating mechanism is genuinely sound. Multiple writes to the same cell monotonically advance the lattice. This is the core invariant that prevents infinite loops and spurious cascades.

2. **Tier-based scheduling**: Enforcing runtime < analysis < transform ordering is mechanically sound and prevents stale facts from triggering transforms.

3. **Practical safety under determinism**: For deterministic programs with no race conditions, the system produces correct results under the stated assumptions (LBD, purity analysis correctness, etc.). The framework hasn't been reported to have memory corruption or silent crashes in the wild.

4. **CFG rebuild batching**: The decision to batch rebuilds (accumulate in `pendingRebuilds`, flush after `processQueue`) is correct and necessary for interpreter safety.

### What Is Genuinely Novel (If Anything)

1. **Reactive specialization during interpretation**: The idea of mutating source AST in response to runtime observations *without* full re-compilation is interesting. SAC does incremental execution (fixed program, changing data); py-slang does incremental specialization (changing program). They're orthogonal problems.

2. **Coarse-grained change propagation via lattices and equality-gating**: Instead of fine-grained dependency tracking (SAC style) or hand-rolled dirty flags, using lattice joins and equality checks to gate cascades is elegant and reduces bookkeeping.

3. **No pin counts, no active-scope tracking**: By relying on LBD + monotone lattices, the framework avoids the bookkeeping complexity of systems like SAC that must track which computations are in-flight.

### What Is Engineering Over Theory

1. **Termination proof**: Assumed to hold by measuring AST size and counting transforms, but not formally proven. Relies on an ordering of transforms that isn't explicitly specified.

2. **Idempotence enforcement**: Heuristic guards (`isAlreadyWrapped`) instead of lattice-level markers. Brittle if user code happens to match the pattern.

3. **Purity analysis**: Speculative and not mechanically verified. If the analysis is unsound, the system silently produces wrong results.

4. **LBD enforcement**: Social contract only. New backends must document and test it, but nothing prevents a bug.

5. **Monotonicity of transfer functions**: Not checked. Relies on discipline.

### What Is Unresolved

1. **Interaction between multiple transform rules**: If several transforms all read overlapping facts and all mutate the AST, the order matters for *precision* (not correctness, but optimality). No topological ordering is enforced; FIFO within tiers can miss opportunities.

2. **Cascading transform amplification**: If const-folding enables dead-branch, which enables more const-folding, iteration count can be high. No mechanism to bound or warn about pathological cases (e.g., exponential iteration).

3. **Incremental CFG updates**: Differential dataflow would update the CFG incrementally. We rebuild entirely. For large functions, this is wasteful.

4. **Mechanical enforcement of LBD and idempotence**: Both would require additional bookkeeping (version markers, per-statement checks) that we've chosen to avoid for simplicity.

---

## Final Summary

**py-slang's specialization engine is sound in practice but not in theory.** It applies well-known techniques (monotone lattices, fixed-point iteration, equality-gating) correctly, but makes several disciplinary assumptions that are not mechanically enforced:

- **Late-binding dispatch** (interpreter contract).
- **Idempotent transforms** (guarded by heuristics).
- **Monotone transfer functions** (design discipline).
- **Sound purity analysis** (empirical testing).
- **Terminating transform cascades** (measured, not proven).

The system works because:
1. The underlying lattice framework is sound.
2. Tier-based scheduling prevents stale-fact bugs.
3. Batched CFG rebuilds preserve interpreter state.
4. Deterministic programs + careful transform design = correct results.

The system's novelty lies in **reactive source-level specialization during interpretation**, not in the underlying analysis/transformation machinery (which borrows from compiler textbooks). It trades theoretical guarantees for engineering simplicity, which is a reasonable choice for a research prototype but would require hardening (mechanical guards, runtime checks, formal verification) for production use.

---

**Committee Recommendation**: **Pass, with major revisions requested:**

- Add mechanical enforcement for at least idempotence (use marker nodes, not heuristic pattern matching).
- Document LBD as a formal precondition; add tests verifying new backends.
- Prove or bound termination formally (or at least document the assumption clearly).
- Add runtime detection of non-terminating cycles (iteration count warning).

