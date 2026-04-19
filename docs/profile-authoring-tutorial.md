# Writing runtime profiles, observation channels, and profitability signals

This note is for **profile authors**.

In this codebase, a "profile" is not just a log file. It usually means one of
three things:

1. a runtime observation channel that records what the program did;
2. a profitability signal that helps decide whether an optimization is worth it;
3. a new narrowing dimension that turns observations into speculative facts.

Those are related, but they are **not the same thing**.

That distinction is the theory you should start from.

---

## 1. Theory: the four categories

Before adding a new signal, classify it.

### A. Semantic fact

A stable truth derived from the program itself.

Examples:

- root type facts;
- root const facts;
- purity;
- liveness.

Profile authors usually are **not** adding these.

### B. Runtime observation

"The runtime has seen X at site Y."

Examples:

- `runtimeWriteAnalysis`
- `runtimeReturnAnalysis`

Observations feed speculation. They are not semantic truth.

### C. Profitability signal

"Optimization Z is now worth considering."

Example:

- `runtimeCallAnalysis`

This is policy input, not semantic proof.

### D. Speculative narrowing

A way to turn an observation into an assumption in a non-ROOT `Context` and
rerun some analyses under that assumption.

Examples:

- type narrowing from `runtimeWriteAnalysis`;
- const narrowing from `runtimeWriteAnalysis`;
- return-kind narrowing from `runtimeReturnAnalysis`.

A single feature may involve multiple categories, but they should stay
separated in the design.

---

## 2. The model in one line

The runtime/profile pipeline is:

```text
runtime event -> runtime analysis cell -> optional onObserve hook -> optional Context extension -> speculative rerun / policy consumer
```

The key word is **optional**.

Not every profile signal should extend speculation.
Not every profile signal should feed transforms.
Not every profile signal should be visible to backends.

---

## 3. The existing examples

Read these first:

- `src/specialization/framework/runtime-analyses.ts`
- `src/specialization/framework/dfa-analyses.ts`
- `src/specialization/framework/worklist.ts`
- `docs/fact-surfaces-and-speculation.md`

Current examples:

- `runtimeWriteAnalysis` — observation source for node-level type/const narrowing;
- `runtimeReturnAnalysis` — observation source for return-kind narrowing;
- `runtimeCallAnalysis` — saturating profitability counter, not a speculation source.

Those three together are the current model vocabulary.

---

## 4. Start by asking the right design questions

Before you write code, answer these.

### Question 1: what kind of thing is this signal?

Is it:

- a runtime observation?
- a profitability signal?
- a narrowing source?
- more than one of those, but still kept separated?

### Question 2: what is its key space?

Examples:

- `nodeId`
- `functionId`
- `Unit`

The key space should match the natural ownership of the signal.

### Question 3: what does conflict mean?

If the runtime sees two different values, should the cell:

- widen to an `unknown` / top-like state?
- saturate to a maximum count?
- overwrite last-seen?
- accumulate a set?

The answer belongs in the store algebra.

### Question 4: should this signal extend speculation?

If yes:

- define a `Narrowing`;
- choose the `observationSource`;
- define `lift(observed)`;
- make sure the lifted value is something a non-ROOT context can bind as an assumption.

If no:

- keep it as an observation or profitability-only channel.

### Question 5: who consumes it?

Possible consumers:

- speculation pipeline
- transforms
- backend compilation
- evaluator policy / tiering
- tests / metrics only

Being explicit here prevents accidental overreach later.

---

## 5. Writing a runtime observation analysis

A runtime observation analysis is usually:

- `tier: "runtime"`
- `polarity: "opaque"`
- written through `worklist.observe(...)`
- equipped with `onObserve(...)` only if it participates in speculation

Skeleton:

```ts
export const runtimeFooAnalysis: Analysis<NodeId, FooObserved> = defineAnalysis({
  id: Symbol("runtimeFooAnalysis"),
  debugName: "runtimeFooAnalysis",
  keySpace: "nodeId",
  storeAlgebra: fooObservationLattice,
  edges: [
    {
      on: "retire",
      effect: (ctx, unit) => {
        for (const nodeId of ctx.topology.nodesOfUnit(unit)) {
          runtimeFooAnalysis.store.evict(nodeId, ROOT_CONTEXT);
        }
      },
    },
  ],
  tier: "runtime",
  polarity: "opaque",
  onObserve(host, key, value, context) {
    if (context !== ROOT_CONTEXT) return;
    host.handleObservationForSpec(runtimeFooAnalysis, key, value);
  },
  transfer(_ctx, _key) {
    return undefined;
  },
});
```

### Why `transfer` is empty

Because the runtime is the producer. The analysis store is updated by
`worklist.observe(...)`, not by scheduled transfer.

### Why `polarity` is `"opaque"`

Because runtime observations are not semantic may/must facts.

---

## 6. Writing the observation sink helper

Runtime-facing code usually should not know the analysis store's value shape.
Give it a helper that classifies raw runtime values and forwards them through
`observe(...)`.

Pattern from `observeRuntimeWrite(...)` / `observeRuntimeReturn(...)`:

```ts
export function observeRuntimeFoo(
  observer: { observe: (p: Analysis<NodeId, FooObserved>, k: NodeId, v: FooObserved) => void },
  nodeId: NodeId,
  raw: unknown,
): void {
  const prev = runtimeFooAnalysis.store.tryRead(nodeId, ROOT_CONTEXT);
  if (alreadySaturated(prev)) return;
  observer.observe(runtimeFooAnalysis, nodeId, classifyFoo(raw));
}
```

That helper is where you can cheaply short-circuit once the cell has reached a
sealed/saturated state.

---

## 7. Adding a profitability signal

A profitability signal often looks like `runtimeCallAnalysis`:

- it records runtime evidence;
- transforms or evaluators may read it;
- it does **not** drive speculative context extension.

Typical shape:

```ts
export const runtimeHotnessAnalysis: Analysis<FunctionId, number> = defineAnalysis({
  id: Symbol("runtimeHotnessAnalysis"),
  debugName: "runtimeHotnessAnalysis",
  keySpace: "functionId",
  storeAlgebra: saturatingCountLattice,
  edges: [...],
  tier: "runtime",
  polarity: "opaque",
  transfer() { return undefined; },
});
```

Then a transform or evaluator can consume it as policy input:

```ts
const hot = facts.read(runtimeHotnessAnalysis, fd.id);
if (hot >= THRESHOLD) {
  // worthwhile now
}
```

Important rule:

> Profitability signals decide whether to optimize, not whether a rewrite is semantically valid.

---

## 8. Turning an observation into a speculation dimension

If the signal should extend non-ROOT contexts, you add a `Narrowing`.

Skeleton:

```ts
export const fooNarrowing: Narrowing<NodeId, FooAssumption> = {
  handle: fooHandle,
  blockAnalysis: () => fooAnalysis,
  observationSource: runtimeFooAnalysis,
  lift: observed => liftFoo(observed),
};
```

Then register it in the narrowing list, typically in `dfa-analyses.ts`.

What that does:

- the worklist's observation translator will consider it when `runtimeFooAnalysis`
  receives an observation;
- if `lift(...)` returns a value, the owning unit's active `Context` may be
  extended with that assumption;
- the relevant block analysis reruns under the new context.

### When to override `resolveUnit`

The default is node-owned lookup.

Override it when the observation key is not a node id, e.g. function-level
return-kind observations that should mutate the called function's unit.

### When to override `lineageValue` / `lineageEq`

Only when the default expr-fact lineage surface is not the right notion of
"the fact this assumption actually shaped".

---

## 9. Where authors usually go wrong

### Mistake 1: turning observations into ROOT truth

Do not let runtime observations strengthen semantic ROOT analyses directly.
They should feed speculation, not redefine program meaning.

### Mistake 2: using one channel for both semantics and profitability

If a signal means both "I saw value X" and "optimization Y seems hot", split
those roles. Mixing them makes the model impossible to reason about.

### Mistake 3: adding `onObserve` to every runtime analysis

Only analyses that should participate in observation-to-context translation need
`onObserve`.

`runtimeCallAnalysis` is the counterexample: useful, runtime-driven, but not a
narrowing source.

### Mistake 4: bad conflict behavior in the lattice

If two distinct observations arrive, your algebra must define what happens.
If that is vague, downstream behavior becomes accidental.

### Mistake 5: too many framework edits for one new signal

A good new signal should usually need changes in a small number of clear places:

- runtime analysis declaration;
- sink helper / runtime callback wiring;
- optional narrowing registration;
- consumer wiring.

If you need to edit many unrelated modules, that may reveal an unnecessary
architectural coupling.

---

## 10. Choosing between the three common patterns

### Pattern A: observation only

Use this when you want to record something, inspect it, or maybe export metrics,
but it should not affect specialization directly.

### Pattern B: profitability only

Use this when the signal decides whether some transform/JIT action is worth
applying, but does not justify semantics.

### Pattern C: observation + narrowing

Use this when the signal should enable guarded speculative optimization.

This is the highest-care path because it interacts with deopt and soundness.

---

## 11. A practical recipe

### To add a new runtime observation channel

1. Pick the key space and observed value domain.
2. Define its store algebra, including conflict/saturation behavior.
3. Declare a runtime `Analysis<key, observed>` with `tier: "runtime"` and
   `polarity: "opaque"`.
4. Add a sink helper that classifies raw runtime values and calls `observe(...)`.
5. Wire the runtime/evaluator to call that helper.
6. Add `onObserve(...)` only if the signal should feed speculation.

### To add a new profitability signal

1. Model it as a runtime analysis with a suitable algebra.
2. Do not add `onObserve(...)` unless it truly should extend contexts.
3. Have transforms/evaluators consume it as a policy gate.

### To add a new narrowing dimension

1. First add the observation source.
2. Then define a `Narrowing` with `handle`, `blockAnalysis`,
   `observationSource`, and `lift(...)`.
3. Register it in the narrowing list.
4. Ensure the backend/guard story is clear for any speculative consumer.

---

## 12. What to read in code

- `src/specialization/framework/runtime-analyses.ts`
- `src/specialization/framework/dfa-analyses.ts`
- `src/specialization/framework/worklist.ts`
- `src/specialization/framework/speculation-strategy.ts`
- `src/tests/specialization/runtime/observation.test.ts`
- `src/tests/specialization/runtime/speculative-narrowing.test.ts`
- `src/tests/specialization/runtime/jit-pipeline.test.ts`

---

## 13. Short checklist

- [ ] Have I classified this signal correctly: observation, profitability, narrowing, or some split combination?
- [ ] Is the key space the natural owner of the event?
- [ ] Does the store algebra define conflict/saturation clearly?
- [ ] Is `polarity: "opaque"` correct for this runtime-driven channel?
- [ ] Should `onObserve(...)` exist at all?
- [ ] If this drives speculation, is there a `Narrowing` with the right `observationSource`?
- [ ] Are consumers treating it as policy input vs semantic proof correctly?
- [ ] Did adding this signal require more framework surgery than it should?

If the last answer is yes, that may be an architectural simplification clue.
