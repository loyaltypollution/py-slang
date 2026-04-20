# Writing a narrowing dimension

This guide is best read from the perspective of an evaluator or backend author
who wants the framework to learn from runtime observations.

We will use one concrete question throughout:

> "When my evaluator sees that `x` evaluated to `0` at some AST node, how do I
> get the framework to recognize that and rerun constant propagation under that
> assumption?"

That is the right canonical example because it explains the whole pipeline:

- the evaluator emits an observation;
- the runtime observation is classified and stored;
- a narrowing lifts that observation into a `Context` assumption;
- the relevant block DFA is re-seeded under the new context;
- speculative facts become sharper;
- canonical transforms still stay ROOT-only for permanent AST rewrites;
- speculative clone bodies are a distinct compilation-artifact path added
  later that reads non-ROOT facts (see §8 and `speculative-clone.ts`).

In many cases, **you do not need to invent a new narrowing at all**. If your
question is specifically "how do I make the framework notice that this node was
`0` at runtime?", the existing `constNarrowing` is already the mechanism.

So this tutorial does two things:

1. shows the evaluator author what to call for the `x = 0` case;
2. shows the narrowing author how the existing const narrowing is written, so
   you know what a new narrowing would look like if your case is not already
   covered.

---

## 0. The running example

```python
def f(x):
    if x == 0:
        return 1
    return x + 2
```

At ROOT, constant propagation cannot conclude that `x == 0`.

But suppose the evaluator repeatedly sees the read of `x` produce `0` at
runtime. Then a speculative run should be able to assume:

- at this node, the value behaves like the constant `0`;
- therefore `x == 0` is true in that speculative context;
- therefore the specialized backend may produce code for the hot `return 1`
  path;
- but the source AST must not be rewritten as though `x == 0` were always true.

That is exactly what a narrowing is for.

---

## 1. If you are the evaluator author: what do you actually write?

Usually, this:

```ts
import { observeRuntimeWrite } from "../framework/runtime-analyses";

observeRuntimeWrite(worklist, nodeId, value);
if (worklist.hasPendingWork()) worklist.drain();
```

Or, if you are wiring the standard observer bundle, this eventually happens via:

```ts
const observers = makeJitObservers(worklist);
observers.observeNodeWrite(nodeId, value);
```

For our running example, when the evaluator reaches the AST node that read `x`
and the concrete value is `0`, it should report:

```ts
observeRuntimeWrite(worklist, xRead.id, 0);
```

That is the whole evaluator-side hook.

You are **not** constructing a `Context` yourself.
You are **not** invoking `constAnalysis` directly.
You are **not** calling a narrowing by name.

You emit a runtime observation. The framework does the rest.

---

## 2. What happens after `observeRuntimeWrite(..., 0)`?

Here is the same event as a concrete pipeline.

```text
evaluator sees xRead evaluate to 0
  -> observeRuntimeWrite(worklist, xRead.id, 0)
  -> classify raw value as RawKind { kind: "number", value: 0 }
  -> worklist.observe(runtimeWriteAnalysis, xRead.id, ...)
  -> runtimeWriteAnalysis.onObserve fires before the store write
  -> worklist.handleObservationForSpec(runtimeWriteAnalysis, xRead.id, number 0)
  -> choose narrowings whose observationSource === runtimeWriteAnalysis
  -> constNarrowing applies
  -> constNarrowing.lift(number 0) = Const(0)
  -> resolve owning unit from xRead.id
  -> extend that unit's active Context with assumption
  -> enqueue constAnalysis.env(entry, speculativeContext)
  -> fire specContextChange(unit)
  -> later: constAnalysis reruns under that speculative Context
```

> "The evaluator observed that node `xRead.id` produced the value `0`, so the
> runtime write observation source emitted a `number 0`, which const narrowing
> lifted into a `Const(0)` assumption."

---

## 3. The canonical narrowing: `constNarrowing`

Here is the narrowing that already handles the `x = 0` example:

```ts
export const constNarrowing: Narrowing<NodeId, ConstLattice> = {
  handle: constExprHandle,
  blockAnalysis: () => constAnalysis,
  observationSource: runtimeWriteAnalysis,
  lift: liftConst,
};
```

Read it field by field, using the concrete example.

| Field | Meaning in the `x == 0` example |
|---|---|
| `handle: constExprHandle` | the context assumption is “node N has constant value C” |
| `blockAnalysis: () => constAnalysis` | rerun constant propagation under that assumption |
| `observationSource: runtimeWriteAnalysis` | only runtime write observations may trigger this narrowing |
| `lift: liftConst` | convert raw runtime values like `number 0` into `Const(0)` |

That is all a narrowing is: a declarative bridge from observation source to
speculative re-run.

---

## 4. The most important idea: a narrowing is not the observation source

These are different jobs.

### The runtime analysis says

> "At runtime, node `xRead.id` has been seen with value `0`."

Concretely, that is `runtimeWriteAnalysis`.

### The narrowing says

> "A runtime write observation from this source may justify a non-ROOT
> assumption in this domain, and that assumption should cause this block DFA to
> rerun."

Concretely, that is `constNarrowing`.

If you collapse those two concepts, the design becomes muddy fast.

---

## 5. What `lift` means, concretely

The hardest sentence in these tutorials is usually the word "lift" because it
sounds more abstract than the job actually is.

For `constNarrowing`, `lift` means:

> "Can this raw observed value be represented as a constant fact?"

The implementation is straightforward:

```ts
export function liftConst(observed: RawKind): ConstLattice | undefined {
  switch (observed.kind) {
    case "number":
    case "bool":
      return constOf(observed.value);
    case "string":
      return observed.value !== undefined ? constOf(observed.value) : undefined;
    default:
      return undefined;
  }
}
```

For our example:

```text
liftConst({ kind: "number", value: 0 }) = Const(0)
```

If the observation had been too vague, such as `unknown`, then the narrowing
would not gain a stronger constant assumption from it.

So "lift" just means:

> turn a runtime observation into an assumption value in the target fact domain,
> if that is honest to do.

---

## 6. Where does the assumption live?

In a `Context` chain.

For our example, after observing `xRead.id = 0`, the active context for the
owning unit may become conceptually like:

```text
ROOT
  -> (constExprHandle, xRead.id, Const(0))
```

That does **not** mutate ROOT facts.

It creates a non-ROOT partition where analyses may read the extra assumption.
In `const-analysis`, the visitor checks the context when recording expression
facts and meets the semantic fact with any matching assumption.

So the same program can now have both:

- ROOT facts: conservative, always-sound
- speculative facts: sharper, assumption-dependent, revocable

---

## 7. What reruns, exactly?

The narrowing points at a block DFA via `blockAnalysis`.

For `constNarrowing`, that means `constAnalysis`, which is a paired block DFA:

- `constAnalysis.env`
- `constAnalysis.facts`

When the context is extended, the worklist re-seeds the entry block of
`constAnalysis.env` under the new context. That rerun side-writes
`constAnalysis.facts` as usual.

Using the running example:

```python
def f(x):
    if x == 0:
        return 1
    return x + 2
```

A speculative rerun can now discover:

- the read of `x` is `Const(0)` in this context;
- `x == 0` is true;
- the true branch is the only feasible one in the speculative run;
- the return value is `1` in that speculative context.

That sharper result is available to speculative consumers such as JIT artifact
selection.

---

## 8. Why canonical transforms must not use speculative facts for permanent AST rewrites

Suppose the evaluator saw `x == 0` a hundred times.

Even then, `deadBranchRule` must not rewrite the source AST to delete the else
branch unless the condition is constant at ROOT.

Why?

Because the AST is shared program structure. A speculative observation is a
revocable hypothesis, not a universal truth.

So the pipeline intentionally splits in two:

- **narrowings** sharpen non-ROOT facts;
- **canonical transforms** (`TransformRule.sweep`) read ROOT facts only and mutate `unit.body` permanently.

If you keep just one thing from this tutorial, keep that boundary.

---

**Scope note: speculative clone bodies are a distinct path.**

After the original transform/narrowing split was established, `speculative-clone.ts`
added a second lane: it produces an ephemeral, per-`(Unit, Context)` clone of a
function body for JIT compilation. That lane uses `transformFacts(topology, context)`
bound to a **non-ROOT context** — so it can see sharper speculative facts when
pruning dead branches and inserting memoization in the clone.

This is intentional because clones are compilation artifacts, not canonical
program structure. They can be discarded on deopt without corrupting the shared
AST. The rule is therefore more precisely:

- permanent AST mutations (`unit.body`) must read ROOT facts only;
- ephemeral clone bodies may read non-ROOT facts because they are retractable.

A canonical `TransformRule` author never calls `transformFacts(topology, context)`
directly — that is the clone lane's concern. But it is worth knowing the boundary
expanded here.

---

## 9. When do you need a new narrowing instead of just emitting observations?

For many evaluator writers, the answer is: **you do not**.

If your evaluator can already say things like

- "this node produced the number `0`"
- "this node produced a string"
- "this function returned a bool"

then existing narrowings may already cover you.

You need a new narrowing only when all of these are true:

1. you have a new class of runtime observation;
2. that observation justifies a revocable non-ROOT assumption;
3. some existing block analysis should rerun under that assumption, or a new
   one should exist for it;
4. the assumption is not already expressible by an existing narrowing.

So before adding a new narrowing, ask:

> "Can I get what I need by simply emitting the right existing observation?"

For `x = 0`, the answer is yes: emit `observeRuntimeWrite(worklist, xRead.id, 0)`.

---

## 10. If you really are authoring a new narrowing, answer these four concrete questions

The old abstract phrasing becomes much clearer if we ask the questions in the
form of the running example.

### Question 1: what exactly was observed?

For the canonical case:

```text
node xRead.id produced runtime value 0
```

That becomes a `RawKind` from a runtime analysis.

### Question 2: what assumption does that justify?

For the canonical case:

```text
under speculation, node xRead.id may be treated as Const(0)
```

That is the value carried in the `Context` assumption.

### Question 3: which analysis should rerun because of that assumption?

For the canonical case:

```text
constAnalysis
```

because it is the analysis whose facts are sharpened by the assumption.

### Question 4: which unit owns the assumption?

For the canonical case:

```text
the unit containing xRead.id
```

That is why the default node-to-unit ownership works.

These four concrete questions are the practical meaning of a narrowing.

---

## 11. The full contract, with plain-English readings

```ts
export interface Narrowing<K = any, V = unknown> {
  readonly handle: AssumptionHandle<K, V>;
  readonly blockAnalysis: () => BlockFixpointAnalysis<any>;
  readonly observationSource: Analysis<K, RawKind>;
  resolveUnit?(ctx: AnalysisCtx, key: K): Unit | undefined;
  lineageValue?(unit: Unit, key: K, context: Context): unknown;
  lineageEq?(a: unknown, b: unknown): boolean;
  lift(observed: RawKind): V | undefined;
}
```

Read each field like this.

### `handle`

What kind of assumption is being inserted into the context?

In the canonical const case:

```text
(nodeId -> ConstLattice assumption)
```

### `blockAnalysis`

Which block DFA should be re-seeded when this assumption appears?

In the canonical const case:

```text
constAnalysis
```

### `observationSource`

Which runtime event family is allowed to trigger this narrowing?

In the canonical const case:

```text
runtimeWriteAnalysis
```

### `lift(observed)`

How do I convert a raw observation into an assumption value?

In the canonical const case:

```text
number 0 -> Const(0)
```

### `resolveUnit?`

If the observation key is not a node id owned by the containing unit, which
unit should receive the assumption?

Most node-keyed narrowings do not override this.

### `lineageValue?` / `lineageEq?`

When a guard fails and deopt tries to prune just the load-bearing assumptions,
what fact surface counts as the thing this narrowing was really shaping?

Most node-level type/const narrowings do not need to override this either.

---

## 12. The default case is intentionally small

Most narrowings in this codebase are the simple case:

- source: `runtimeWriteAnalysis`
- key space: `NodeId`
- owner unit: `topology.unitOfNode(key)`
- lineage surface: expr fact at that node under the block DFA

That is why these definitions are so short:

```ts
export const typeNarrowing: Narrowing<NodeId, TypeLattice> = {
  handle: typeExprHandle,
  blockAnalysis: () => typeAnalysis,
  observationSource: runtimeWriteAnalysis,
  lift: liftType,
};

export const constNarrowing: Narrowing<NodeId, ConstLattice> = {
  handle: constExprHandle,
  blockAnalysis: () => constAnalysis,
  observationSource: runtimeWriteAnalysis,
  lift: liftConst,
};
```

That shortness is not hiding magic. It means the defaults are doing the right
thing.

---

## 13. When you override `resolveUnit`

Override it only when the observed key is not naturally owned by
`topology.unitOfNode(key)`.

The main in-tree example is return-kind narrowing, where the key is a
`FunctionId`, not a node id. In that case the narrowing must say:

```ts
resolveUnit: (ctx, key) => ctx.topology.unitOfFunctionId(key)
```

For the `x = 0` case, you do **not** need this override.

---

## 14. When you override lineage

Override lineage only when the thing guarded by the backend is not best modeled
as "the expr fact at this observed node".

The important example is return-kind narrowing, where the backend may depend on
an entry requirement environment rather than one node fact.

For the `x = 0` const example, the defaults are correct.

---

## 15. Registration

A narrowing is active only if it is registered.

The main lists are in `src/specialization/framework/dfa-analyses.ts`:

```ts
export const DEFAULT_NARROWINGS = [
  typeNarrowing,
  constNarrowing,
  returnKindNarrowing,
];

export const JIT_RELEVANT_NARROWINGS = [
  constNarrowing,
  returnKindNarrowing,
];
```

The distinction is important:

- `DEFAULT_NARROWINGS` = dimensions the speculation pipeline knows about
- `JIT_RELEVANT_NARROWINGS` = dimensions that actually shape current SVML
  artifact choice

For the evaluator author trying to get `x = 0` recognized, the key takeaway is:

- you do not register anything new;
- `constNarrowing` is already there;
- just emit the runtime write observation.

---

## 16. Common mistakes, phrased against the canonical example

### Mistake 1: writing a new narrowing when an existing one already fits

If your only need is "I saw node `xRead.id` evaluate to `0`", do not invent
`zeroNarrowing`. Just emit a runtime write observation and let
`constNarrowing` do its job.

### Mistake 2: confusing observation with assumption

Observed runtime value:

```text
xRead.id produced 0
```

Speculative assumption:

```text
in this context, treat xRead.id as Const(0)
```

Those are related, but not the same thing.

### Mistake 3: making `lift` stronger than the observation justifies

If the runtime evidence only supports "number", do not claim "constant 0".

### Mistake 4: targeting the wrong block analysis

The block analysis should be the analysis whose facts are sharpened by the
assumption. For `Const(0)` assumptions, that is `constAnalysis`, not some
unrelated transform or backend module.

### Mistake 5: forgetting that transforms are ROOT-only

A speculative const fact may justify specialized code generation, but not an AST
rewrite that must be universally sound.

---

## 17. Practical recipes

### Recipe A: evaluator author, existing const narrowing

You want the framework to learn that a node behaved like constant `0`.

1. Identify the relevant AST node id.
2. Call:

   ```ts
   observeRuntimeWrite(worklist, nodeId, 0);
   ```

3. Drain the worklist if needed.
4. Let `constNarrowing` extend the speculative context and rerun
   `constAnalysis`.

### Recipe B: authoring a genuinely new narrowing

1. Name the assumption clearly.
2. Decide which runtime observation source justifies it.
3. Decide which block DFA should rerun.
4. Implement `lift(observed)` honestly.
5. Override `resolveUnit` only if node ownership is wrong.
6. Override lineage only if the default node expr fact is the wrong deopt
   surface.
7. Register the narrowing.
8. Add tests for observation, context extension, rerun, and deopt pruning.

---

## 18. What to read in code

If you want to follow the `x = 0` example through the codebase, read these in
this order:

- `src/specialization/framework/runtime-analyses.ts`
  - `observeRuntimeWrite`
  - `runtimeWriteAnalysis.onObserve`
- `src/specialization/framework/worklist.ts`
  - `handleObservationForSpec`
  - `specContextFor`
  - `widenGuard`
- `src/specialization/const-analysis/analysis.ts`
  - `liftConst`
  - `constExprHandle`
  - the visitor's context-aware annotation path
- `src/specialization/framework/dfa-analyses.ts`
  - `constNarrowing`
  - `DEFAULT_NARROWINGS`
  - `JIT_RELEVANT_NARROWINGS`
- `src/tests/specialization/runtime/speculative-narrowing.test.ts`

---

## 19. Short checklist

For the evaluator author trying to get `x = 0` recognized:

- [ ] Am I calling `observeRuntimeWrite(worklist, nodeId, 0)` at the right AST node?
- [ ] Do I drain the worklist after observation if pending work exists?
- [ ] Am I expecting speculative sharpening, not ROOT AST rewriting?

For the author of a new narrowing:

- [ ] Can I name the assumption dimension in one sentence?
- [ ] Is `observationSource` the right runtime event family?
- [ ] Is `lift(...)` honest?
- [ ] Is `blockAnalysis` the analysis actually sharpened by the assumption?
- [ ] Does ownership land on the correct unit?
- [ ] Does lineage point at the fact surface guards really depend on?
- [ ] Is this really a new dimension, or should I just emit an existing observation?

If the last answer is "I should just emit an existing observation", that is a
success, not a failure. It means the framework abstraction is doing useful work.
