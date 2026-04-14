# py-slang specialization & execution flow

Traces how a resolved AST becomes running, optimized code. Parsing and
resolution are assumed; this document starts from `(ast, environments)`
and ends at a JS return value.

For the contract/stability view, see `docs/optimization-roadmap.md`.

For a hands-on view of what specialization produces:

```
npx tsx scripts/dump-ast.ts <file.py> -o out.dot
```

---

## The primitives

Three types carry the entire framework. Everything else is written in
terms of these.

### `Pass<K, V>`
A scheduled computation. One shape for every analysis, every derived
fact, every transform, every codegen install. Fields that matter:

- `lattice: Lattice<V>` — `bottom`, `equals`, `join`. `equals` gates
  every fan-out; `join` is rarely used outside Kildall DFA.
- `reads: Pass[]` — upstream dependencies. Declared, not discovered.
- `transfer(ctx, key) → V | undefined` — pure function of upstream
  facts. Returning `undefined` means "no write" (distinct from writing
  `bottom`, which is an explicit reset).
- `affectedKeys(ctx, triggerPass, triggerKey) → K[]` — on an upstream
  write, names the exact subset of this pass's keyspace to re-enqueue.
  Passes without a precise mapping set `coarse: true` and re-run every
  previously-written key.
- `tier: "runtime" | "analysis" | "transform"` — drain-order
  tiebreaker. Analysis drains before any transform that reads it.

There is no separate `AnalysisPass` / `ScopePass` / `TransformRule`.
Granularity is encoded in `K` — a node, a scope id, a `FunctionUnit`,
whatever this pass is keyed on.

### `FactStore`
The sole storage substrate. Two-level map keyed by `(pass, key)`.
`write` compares against the stored value under `pass.lattice.equals`:
an equal write is a no-op and fires no listener. This equality gate is
the *one* mechanism that suppresses redundant downstream work. Every
"did this change" question in the system reduces to it.

### `Worklist`
The scheduler. Owns a `FactStore`, a registered pass set, and one
priority queue ordered by tier (runtime < analysis < transform) with
FIFO-within-tier via a monotonic sequence number. Public surface:

- `new Worklist(ast, environments, passes? = DEFAULT_PASSES)`
- `drain(limit?)` — run to fixpoint. Loop of: pop PQ to empty, then
  flush any CFG rebuilds that transforms scheduled, repeat until no
  rebuilds remain. Returns the set of units that rebuilt (callers
  needing a boolean use `.size > 0`).
- `observe(pass, key, value)` — runtime-observation entry; writes the
  fact and pops the PQ to empty synchronously. Does **not** flush CFG
  rebuilds — see "Transform-safety invariant" below.
- `register(pass)` — add a pass post-construction (the SVML JIT uses
  this to register `jitPass` after it has an interpreter in hand)
- `enqueue(pass, key)` — deduped enqueue, mostly for pass authors who
  need to self-schedule
- `units`, `factStore` — read-only handles

### Transform-safety invariant
Transforms can fire during `observe`, mutating the AST mid-execution.
This is load-bearing: memoization, dead-branch, and constant-folding
would be useless if they only fired at program exit. CFG rebuilds are
batched — `observe` populates `pendingRebuilds` but flushes only on
`drain`. That is safe because the interpreter (CSE or SVML) never
reads the CFG directly; only analysis passes do, and analyses run
only inside `drain`, which rebuilds first.

The unwritten contract every `tier: "transform"` pass must honour:
**`transfer` runs between interpreter steps and may rewrite the AST
it receives, but must not invalidate any pointer the interpreter
holds across the enclosing `observe` call.** In practice this means:
mutate `FunctionDef.body` in place (memoization swaps the body array;
the currently-executing call frame holds the old body and exits
cleanly, the next call reads the new one), patch function-table slots
(SVML `jitPass`), or rewrite expression nodes that no active frame
captured by reference. Do not free/replace nodes that a running frame
still points into.

`DEFAULT_PASSES`: `structuralPass`, `runtimeWritePass`, `runtimeCallPass`,
`typeAnalysisPass`, `constAnalysisPass`, two block-keyed DFA passes,
`purityScopePass`, `callCountPass`, `deadBranchRule`,
`constantFoldingRule`, `memoizationRule`.

## How dispatch works

1. Something writes a fact — a pass's `transfer` returns a value, or the
   driver calls `observe` with a runtime value.
2. `FactStore.write` compares against the stored value. Equal → done.
3. On a real change, every pass whose `reads` contains the writer
   becomes candidate work. Each candidate's `affectedKeys` names the
   keys to enqueue.
4. The worklist pops items from the PQ in priority order: runtime →
   analysis → transform, FIFO within tier. Each popped item is one
   `transfer(ctx, key)` → one `write`.

Side effects in `transfer` (`patchFunction`, AST mutation) must be
idempotent under `lattice.equals`: if the returned value equals the
stored one, the side effect must be a no-op. That is how the framework
prevents re-fire — no `fireOnce`, no `appliedTransforms` set, no
bookkeeping. The lattice *is* the idempotence.

## Vocabulary

- **Unit** — `FunctionUnit`, one per `FileInput`/`FunctionDef`. Owns
  the body getter and the block index.
- **Fact** — a `(pass, key) → value` entry in the `FactStore`.
- **Fact change** — a `write` that was not suppressed by `equals`.
- **Tier** — PQ priority bucket; runtime < analysis < transform.
- **Source pass** — no `reads`; fed by `observe` (runtime) or the
  worklist itself (structural).
- **LBD (Late-Bound Dispatch)** — interpreters re-resolve callee bodies
  at every CALL: CSE reads `closure.node.body` fresh; SVML re-reads the
  function-table slot and captures the IR into `CallFrame.ir`. Under
  LBD, any body-local ABI-preserving rewrite is safe at any time. The
  framework therefore tracks no pin counts, no active-scope set.

## The pass graph

```
  runtime tier                 analysis tier                 transform tier
  ────────────                 ─────────────                 ──────────────
  runtimeCallPass  ──────────→ callCountPass   ──┐
                                                 ├──────────→ memoizationRule ──┐
  (purity has no runtime dep)  purityScopePass ──┘                              │
                                                                                │
  runtimeWritePass ──────────→ typeAnalysisPass  ───────────→ constantFoldingRule
                               constAnalysisPass ───────────→ deadBranchRule

  structuralPass   ──────────────────────────────────────────→ (all transforms,
                                                                 jitPass)

                               (SVML JIT only)                 jitPass
                                                               reads: callCount,
                                                                 purity, structural,
                                                                 type, const
                                                               writes: SVMLIR
                                                               side effect:
                                                                 patchFunction
```

## fib, end to end

```python
def fib(n):
    return n if n < 2 else fib(n-1) + fib(n-2)
fib(20)
```

### Build
`new Worklist(ast, environments)` constructs units, registers
`DEFAULT_PASSES`, seeds `structuralPass` for every unit.
`worklist.drain()` runs the initial wave to fixpoint.

- `typeAnalysisPass` / `constAnalysisPass` populate per-node facts.
- `purityScopePass` writes `true` for fib (no side effects).
- `callCountPass` reads `runtimeCallPass(fib) = 0`, writes 0.
- `memoizationRule.transfer` runs: `count = 0 < MEMOIZATION_THRESHOLD`,
  returns `undefined`. No write. No fan-out.

### Compile (SVML only)
`SVMLCompiler.fromProgramUnit(ast, environments, units, factStore)`
reads analysis facts directly from the store at emit time — specialized
opcodes (`ADDF`/`NOTB` vs. `ADDG`/`NOTG`), observation-metadata
elision, and so on are pure functions of the current fact state.

### Wire
The evaluator constructs the interpreter with two plain callbacks:

```ts
observeNodeWrite: (nodeId, v) => worklist.observe(runtimeWritePass, nodeId, v)
observeScopeCall: (scopeId)   => { /* saturating bump, then observe */ }
```

`observeScopeCall` keeps a closure-local counter and short-circuits
once the count hits `RUNTIME_CALL_COUNT_SAT`. Post-saturation CALLs
never reach `worklist.observe` — the hot path is a counter compare.

The SVML JIT additionally registers `jitPass` (`engines/svml/jit-pass.ts`):
a `Pass<FunctionUnit, SVMLIR>` whose lattice value is the compiled IR,
whose `equals` is a field-wise structural compare, and whose transfer
recompiles and calls `patchFunction` only when the new IR differs from
the stored one.

### Run
`interpreter.execute()` starts. Each CALL fires `observeScopeCall`.

- Calls 1..9: each `observe` writes a new count, `callCountPass`
  re-executes and writes `min(sat, count)`. The value changed, so the
  change cascades to `memoizationRule`. Its transfer reads
  `count < threshold` and returns `undefined` — no write, no further
  fan-out. Per-call cost: one counter bump, one pass re-execution,
  one equality-suppressed write attempt on `memoizationRule`.

- **Call 10**: `callCountPass` writes 10. `memoizationRule.transfer`
  now reads `count ≥ threshold` and `purity = true`. It calls
  `applyMemoizationWrap(unit)`, which splices a `__memo_has/get/put`
  prelude into `fd.body` and returns `"fired"`. The write propagates.
  - AST mutation bumps `structuralPass` for the unit.
  - `structuralPass` fans out to `jitPass`.
  - `jitPass.transfer` recompiles fib, structurally compares the new
    `SVMLIR` against the stored one, and calls
    `interpreter.patchFunction(index, newIR)`.

- **Call 11**: dispatches the memoized IR. `__memo_has/get/put` route
  through SVML primitives 40/41/42 into `runtime/memo.ts`.

- Calls 12..N: `observeScopeCall` sees the counter already at sat and
  returns before touching the worklist. **O(1) per call** in the
  steady state — the property the framework is designed for.

### Live frames
Frames currently executing fib continue on the pre-patch IR captured
in `CallFrame.ir`. Only new CALLs pick up the patched slot. This is
the LBD contract, not framework state.

## CSE

Two evaluator families wrap the CSE stepper.

| Evaluator | Role |
|---|---|
| `PyCseEvaluator{1..4}` | Plain: parse → `analyze` → `evaluate`. No `Worklist`. Runtime observation callbacks are left `undefined`; the `context.runtime.observe*?.(…)` sites short-circuit. No transforms. |
| `PyCseJitEvaluator{1..4}` | Reactive: parse → `analyzeWithEnvironments` → `new Worklist` → `drain` → wire callbacks on `context.runtime` → `evaluate` → final `worklist.drain()` to flush any deferred CFG rebuilds. |

CSE's materialized form *is* the AST. The next CALL re-reads
`closure.node.body`, which now includes whatever prelude
`memoizationRule` spliced in. There is no `jitPass`, no `patchFunction`,
no compile step — the AST mutation *is* the install.

CSE JIT does not use `RUNTIME_CALL_COUNT_SAT` in the callback. Per-call
cost is high enough that the extra `observe` is in the noise; the
lattice equality gate at `runtimeCallPass` / `callCountPass` suppresses
post-saturation cascade on the framework side.

## What dissolved in the refactor

| Before | After |
|---|---|
| `AnalysisPass` / `ScopePass` / `TransformRule` / `ScopeTransformRule` | Single `Pass<K, V>` shape; granularity encoded in `K` |
| `HintStore`, `OptimizationHint` | `FactStore` keyed by `(pass, key)` |
| `ObservationSink` interface | Two plain callbacks: `observeNodeWrite`, `observeScopeCall` |
| `callObservations[]`, `onScopeChanged`, subscribers/notify | Fact changes drive cascade; listeners live on the `FactStore` |
| `fireOnce`, `appliedTransforms`, `hasNonMonotoneRule`, `forbiddenScopeFields` | Lattice `equals` gates re-fire |
| `structuralVersion` on units | `structuralPass` as a source pass |
| Scheduler tick on every `observeCall` | Cascade only when a lattice value actually changes |

## File index

| Concern | File | Key symbols |
|---|---|---|
| Pass shape | `src/specialization/framework/pass.ts` | `Pass<K,V>`, `PassCtx`, `Lattice<V>` |
| Fact store | `src/specialization/framework/fact-store.ts` | `FactStore.read/write/readAll/onChange` |
| Worklist | `src/specialization/framework/worklist.ts` | `Worklist`, `DEFAULT_PASSES` |
| Units | `src/specialization/framework/function-unit.ts` | `FunctionUnit`, `buildFunctionUnits` |
| Runtime sources | `src/specialization/framework/runtime-passes.ts` | `runtimeWritePass`, `runtimeCallPass`, `RUNTIME_CALL_COUNT_SAT` |
| Structural source | `src/specialization/framework/structural-pass.ts` | `structuralPass` |
| Derived passes | `memoization-analysis/call-count.ts`, `purity-analysis/analysis.ts` | `callCountPass`, `purityScopePass` |
| Transforms | `transforms/{memoization,dead-branch,constant-folding}.ts` | `memoizationRule`, `deadBranchRule`, `constantFoldingRule` |
| SVML compile | `src/engines/svml/svml-compiler.ts` | `SVMLCompiler.fromProgramUnit`, `compileProgram`, `compileFunction` |
| SVML run | `src/engines/svml/svml-interpreter.ts` | `SVMLInterpreter.execute`, `patchFunction` |
| JIT install pass | `src/engines/svml/jit-pass.ts` | `makeJitPass` |
| CSE run | `src/engines/cse/interpreter.ts` | `evaluate` |
| Memo runtime | `src/runtime/memo.ts` | `memoLookup`, `memoPut`, `MEMO_MISS`, `MEMO_INTRINSIC_NAMES` |
| Evaluators | `src/conductor/Py*Evaluator.ts` | `evaluateChunk` |
