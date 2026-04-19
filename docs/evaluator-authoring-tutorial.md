# Writing an evaluator/backend that hooks into specialization

This note is for **evaluator authors** and **backend authors**.

It explains how to connect a runtime or compiler backend to the
specialization engine, what the actual theory of that connection is, and what
mistakes tend to create unsoundness or needless coupling.

The reference implementation today is the SVML JIT path:

- `src/conductor/PySvmlJitEvaluator.ts`
- `src/conductor/svml-jit-analysis.ts`
- `src/engines/svml/svml-compiler.ts`
- `src/engines/svml/svml-interpreter.ts`

Read those alongside this tutorial.

---

## 1. Theory: what an evaluator author is actually wiring

An evaluator/backend author is **not** writing the specialization framework.
They are writing the adapter between:

1. a running backend/runtime, and
2. the framework's fact, transform, and speculation machinery.

Conceptually, the model is:

```text
program AST
  -> Worklist builds/stabilizes semantic facts and runs transforms
  -> backend compiles or interprets the resulting units
  -> runtime emits observations
  -> observations may extend speculative Context
  -> guarded backend recompiles / repatches artifacts for that Context
  -> guard failure widens speculation and falls back or recompiles
```

So the evaluator role is about **integration boundaries**:

- which fact surface the backend reads;
- how observations enter the worklist;
- how compiled artifacts are cached and patched;
- how guard provenance is registered so deopt can prune the right assumptions.

That is why the SVML recompile loop lives in `src/conductor/`, not inside the
framework. It is one strategy for one backend.

---

## 2. The minimal non-JIT evaluator shape

A plain evaluator that wants specialization but not speculative recompilation
usually does this:

1. parse and resolve;
2. build a `Worklist`;
3. drain it so analyses and transforms settle;
4. compile or run using the resulting AST and root facts.

Sketch:

```ts
const ast = parse(script);
const { errors, environments } = analyzeWithEnvironments(ast, script, 4);
if (errors.length > 0) throw errors[0];

const worklist = new Worklist(ast, environments);
worklist.drain();

// Now compile or interpret the transformed AST / settled facts.
```

That is the baseline contract:

- the framework owns analysis/transform convergence;
- the evaluator consumes the result.

If your backend never consumes speculative facts and never emits runtime
observations, you may not need anything more.

---

## 3. The JIT evaluator shape

A speculative or JIT-capable evaluator adds three more responsibilities:

1. hand the backend a fact query that can see active speculation;
2. wire runtime observation callbacks back into the worklist;
3. provide a recompile/repatch strategy when facts or context change.

The reference shape is `PySvmlJitEvaluator`:

```ts
const worklist = new Worklist(ast, environments);
worklist.drain();

const compiler = SVMLCompiler.fromProgramUnit(
  ast,
  environments,
  makeDfaQuery(
    worklist.topology,
    nodeId => worklist.specContextForNode(nodeId),
    unit => worklist.specContextFor(unit),
  ),
  worklist.registry,
  worklist,
);

const interpreter = new SVMLInterpreter(program, {
  sendOutput: msg => this.conductor.sendOutput(msg),
  ...makeJitObservers(worklist),
});

const jitAnalysis = makeJitAnalysis({
  compiler,
  interpreter,
  specContextFor: unit => worklist.specContextFor(unit),
});
worklist.register(jitAnalysis);
```

Those are the core moving parts.

---

## 4. Which fact surface should a backend read?

There are two important choices.

### A. Root-only / transform-safe surface

If a consumer is making decisions that must remain valid without guards, it
must use a root-only surface.

For application-layer reads, that is `StaticDfaQuery`.

### B. Guarded speculative surface

If the backend is willing to emit a runtime guard and deopt path, it can use
`DfaQuery`:

```ts
makeDfaQuery(
  worklist.topology,
  nodeId => worklist.specContextForNode(nodeId),
  unit => worklist.specContextFor(unit),
)
```

That query exposes:

- `typeOf`, `constOf`, `isPureScope` — root-safe reads;
- `speculativeTypeOf`, `speculativeConstOf`, `entryRequirementsOf` — guarded reads.

The rule is simple:

> If the backend consumes a speculative answer, it must also emit a guard whose
> failure can retract that decision.

---

## 5. How runtime observations enter the system

Runtime observations do not directly mutate speculative cells.
They enter at ROOT through `worklist.observe(...)`, and the worklist's
observation translator decides whether they extend the active speculation
context.

The usual evaluator helper is:

```ts
const observers = makeJitObservers(worklist);
```

That produces callbacks for:

- `observeNodeWrite(nodeId, value)`
- `observeScopeCall(scopeId)`
- `observeScopeReturn(scopeId, value)`

The backend/runtime should call those at the relevant runtime sites.

### Important model point

Observations are:

- runtime facts about what just happened;
- rooted at actual execution;
- inputs to speculation;
- not replacements for semantic ROOT facts.

So evaluators should never try to directly write speculative facts into DFA
stores. The runtime emits observations; the worklist translates them.

---

## 6. How recompilation is modeled

The framework does not have a generic notion of "compiled artifact".
That is backend-specific.

Instead, a JIT/backend usually adds an evaluator-scoped analysis whose key is
`Unit` and whose cell is "the currently selected compiled artifact".

SVML does this in `src/conductor/svml-jit-analysis.ts`.

The shape is:

- subscribe to the analyses whose fact changes can change codegen;
- subscribe to lifecycle events like `mint`, `rebuild`, and
  `specContextChange`;
- on transfer, compile or reuse an artifact for the unit's current active
  speculation context;
- patch the backend's live dispatch table only when the artifact actually changed.

That makes recompilation declarative:

```text
fact/context change -> JIT analysis wakes -> transfer recompiles/reuses -> backend patched
```

---

## 7. Per-context caching

Speculative compilation usually needs a cache indexed by:

```text
(unit, Context) -> compiled artifact
```

Why?

- moving **forward** into a fresh speculative child context should compile a
  fresh artifact;
- widening **backward** to an ancestor context should often reuse an artifact
  compiled earlier for that ancestor.

That is the point of the per-context cache in `svml-jit-analysis.ts`.

The framework already gives evaluators the key abstraction for this:

- `Context`
- `ROOT_CONTEXT`
- `worklist.specContextFor(unit)`

So evaluator authors should treat speculation context as an explicit cache axis,
not as an invisible global mode.

---

## 8. Guard registration and deopt provenance

If a backend emits a guard because it relied on a speculative fact, it must
register which fact lineage that guard depends on.

The contract is:

```ts
worklist.registerGuard(guardNodeId, ref)
```

The `ref` describes the speculation fact the guard protects.

Why this matters:

- a guard failure should not blindly throw away all speculation;
- the worklist can prune only the assumption(s) that actually justified the
  failing guard;
- sibling speculation based on independent observations can survive.

That is what makes lineage-precise widening possible.

### Practical rule

> Every guard-emitting backend must call `registerGuard` at emission time.

If you skip this, deopt cannot safely know what to retract.

---

## 9. What belongs in the framework vs in the evaluator

A good evaluator tutorial should make this boundary explicit.

### Framework-owned

- analyses and their stores;
- transform scheduling;
- observation-to-context translation;
- context widening / pruning;
- topology and function registry;
- generic read surfaces (`AnalysisCtx`, `TransformFactView`, `DfaQuery`).

### Evaluator-owned

- backend IR shape;
- compilation strategy;
- artifact equality;
- live patch mechanism;
- when/how compiled artifacts are cached;
- runtime observation call sites;
- deopt/retry mechanics specific to that runtime model.

If evaluator code feels forced to push backend-specific artifact logic into the
framework, that is often a sign the abstraction boundary is being crossed in
the wrong direction.

---

## 10. A step-by-step recipe for a new backend

### Step 1: get a root-only pipeline working

Before speculation, make sure this works:

- parse / resolve;
- `new Worklist(ast, environments)`;
- `worklist.drain()`;
- compile/interpret the resulting AST.

### Step 2: decide whether the backend wants speculative reads

If no, stop there.

If yes, define exactly:

- which speculative facts affect backend artifacts;
- which runtime guards will protect them;
- what deopt means in this backend.

### Step 3: wire observation callbacks from the runtime

Use `makeJitObservers(worklist)` or a backend-specific equivalent.

Emit:

- per-expression write observations if node-level speculation matters;
- per-function return observations if return-kind speculation matters;
- per-function call observations if tiering/profitability matters.

### Step 4: register a backend-specific recompile analysis

Model artifact selection as an evaluator-scoped `Analysis<Unit, Artifact>`.

Subscribe it to:

- relevant `.env` / `.facts` analyses;
- `mint` / `rebuild`;
- `specContextChange` if context changes alter artifact choice.

### Step 5: implement guard provenance

Every speculative codegen choice that survives in emitted code must register a guard.

### Step 6: define fallback/deopt behavior honestly

A backend that cannot retry at an interior execution point should not pretend it
has the same deopt semantics as SVML. Its evaluator strategy may need entry-only
guards, coarser retries, or a different patch model.

`PyWasmJitEvaluator.ts` is a good example of documenting this honestly before
implementation.

---

## 11. Common mistakes

### Mistake 1: treating speculative facts as if they were stable semantic facts

If the backend reads `speculativeConstOf(...)` and bakes it into code without a
guard, that is unsound.

### Mistake 2: direct store mutation from the runtime

The runtime should emit observations, not write speculative DFA cells directly.

### Mistake 3: forgetting `specContextChange`

A pure context prune may advance no facts, but the correct compiled artifact may
still change. Backend recompile analyses that depend on active context must
subscribe to `specContextChange`.

### Mistake 4: no per-context cache axis

Without `(unit, context)` caching, deopt often recompiles work that could have
been reused.

### Mistake 5: missing guard provenance

If `registerGuard` is skipped, lineage-precise widening cannot work.

### Mistake 6: pushing backend strategy into framework APIs too early

SVML patching, WASM table patching, and tree-walker interpretation are not one
mechanism. Keep backend strategy local unless multiple backends truly need the
same abstraction.

---

## 12. What to read in code

Start here:

- `src/conductor/PySvmlJitEvaluator.ts`
- `src/conductor/svml-jit-analysis.ts`
- `src/conductor/PyWasmJitEvaluator.ts`
- `src/specialization/dfa-query.ts`
- `src/specialization/framework/runtime-analyses.ts`
- `src/specialization/framework/worklist.ts`

Then read backend-specific emission / runtime code:

- `src/engines/svml/svml-compiler.ts`
- `src/engines/svml/svml-interpreter.ts`

---

## 13. Short checklist

- [ ] Build and drain a `Worklist` before backend execution.
- [ ] Use `StaticDfaQuery` for stable reads, `DfaQuery` only for guarded speculative reads.
- [ ] Emit runtime observations through the observation callbacks, not through ad hoc store writes.
- [ ] Treat `Context` as an explicit cache partition if artifacts vary by speculation.
- [ ] Register a backend-specific `Analysis<Unit, Artifact>` if recompilation/patching is needed.
- [ ] Subscribe to `specContextChange` when active context affects artifact choice.
- [ ] Register guard provenance for every speculative guard.
- [ ] Keep backend-specific artifact mechanics out of the framework unless they are truly shared.

That is the evaluator-author contract in the current architecture.
