# Topology and key spaces in the specialization engine

This note is for anyone who needs to cross one program index space into another:
analysis authors, transform authors, evaluator authors, and narrowing authors.

The theory first:

> Most accidental complexity in this framework comes from forgetting that
> `nodeId`, `BasicBlock`, `functionId`, and `Unit` are different ownership
> spaces.

This guide explains those spaces, how to bridge across them safely, and what
mistakes make code harder to review than it should be.

---

## 1. Theory: topology is the bridge layer

The engine does not have one universal key space.
It has several program-derived index spaces:

- `nodeId`
- `BasicBlock`
- `functionId`
- `Unit`

Those are not cosmetic type aliases. They represent different ownership views
of the program.

The topology layer exists so authors do not reconstruct those bridges ad hoc.

Conceptually:

```text
AST / CFG / function structure
  -> ProgramTopology indexes crossings
  -> analyses / transforms / backends consume readonly lookups
```

That is why `ProgramTopology` is a first-class surface.

---

## 2. The key spaces and what they mean

### `nodeId`
A particular AST node.

Use when the fact is naturally about one expression or statement.

Examples:

- runtime write observations
- per-expression type facts
- per-expression const facts

### `BasicBlock`
A CFG block inside one unit.

Use when the fact is about transfer / fixpoint state at block granularity.

Examples:

- block DFA `.env` cells
- block DFA `.facts` cells
- liveness / dataflow transfer state

### `functionId`
The `.id` of a scope-owning AST node such as `FileInput` or `FunctionDef`.

Use when the fact is naturally about a function/scope as an identity.

Examples:

- purity summaries
- call counts
- return-kind observations

### `Unit`
The optimization/CFG owner built around one scope AST node.

Use when the consumer cares about one schedulable body as a whole.

Examples:

- transform sweep keys
- JIT compiled artifact keys
- unit rebuild lifecycle

---

## 3. The topology surface

The readonly surface is:

```ts
export interface ProgramTopology {
  readonly units: ReadonlyMap<FunctionId, Unit>;
  unitOfFunctionId(functionId: FunctionId): Unit | undefined;
  unitOfNode(nodeId: NodeId): Unit | undefined;
  blockOfNode(nodeId: NodeId): BasicBlock | undefined;
  nodesOfUnit(unit: Unit): Iterable<NodeId>;
}
```

This is the official bridge layer.

Rule:

> If you need to cross between key spaces, ask whether `ProgramTopology` (or a
> helper built on top of it) should own that crossing.

---

## 4. Common crossings

### A. node -> block

Used for per-expression facts stored in block DFA cells.

Helper:

```ts
readExprFact(topology, analysis, nodeId, context?)
```

Transforms now consume this through `TransformFactView.readExprFact(...)` so
root-only expression-fact reads stay on the transform-safe surface.

### B. node -> unit

Used when an observed node should mutate or query its owning unit.

Example:

```ts
ctx.topology.unitOfNode(nodeId)
```

Common in narrowings and deopt provenance.

### C. functionId -> unit

Used when function-scoped facts or observations need the owning unit.

Example:

```ts
ctx.topology.unitOfFunctionId(functionId)
```

Common in memoization, purity, return-kind narrowing, and evaluator code.

### D. unit -> node set

Used for retirement/eviction paths.

Example:

```ts
for (const nodeId of ctx.topology.nodesOfUnit(unit)) {
  // evict per-node facts
}
```

---

## 5. Why ad hoc bridges are a smell

Before topology was centralized, these bridges were scattered across:

- per-unit fields
- worklist-owned maps
- local recomputation at query/transform sites
- ad hoc AST traversals for retirement

That made two things hard:

1. ownership was unclear;
2. rebuild semantics were harder to trust.

The topology refactor fixed that by making one writer responsible:
`MutableProgramTopology`, owned by the worklist.

Readers should prefer the readonly projection.

---

## 6. Choosing the right key space for a new thing

Ask: what is the natural owner of this fact/event/artifact?

### Use `nodeId` when...
- the fact is about one expression/statement occurrence;
- observations happen at expression sites;
- guards are attached to specific AST conditions/reads.

### Use `BasicBlock` when...
- the fact is transfer/fixpoint state;
- the scheduler should wake on CFG-level propagation;
- the storage naturally belongs to block in/out state.

### Use `functionId` when...
- the fact summarizes one scope;
- the runtime event occurs at function entry/return;
- the consumer does not care about one particular block/node.

### Use `Unit` when...
- the consumer rewrites or recompiles whole bodies;
- lifecycle events are about whole optimization units;
- the action after a change is "resweep/rebuild/recompile this body".

---

## 7. Bridge deliberately inside edges

Edges are one of the most common places where key-space crossings happen.

Example: a transform keyed by `Unit` reacting to a `functionId` fact source:

```ts
{
  on: "fact",
  analysis: purityScopeAnalysis,
  wake: (ctx, functionId) => {
    const unit = ctx.topology.unitOfFunctionId(functionId as number);
    return unit ? [unit] : [];
  },
}
```

This is the right place for the crossing because:

- the upstream key space is explicit;
- the transform key space is explicit;
- the bridge is reviewable.

If the crossing is hidden in unrelated helper code, the dependency graph gets
harder to reason about.

---

## 8. Node id vs function id: the subtle trap

A `FunctionDef` has a node id, but its unit is also keyed by its `functionId`
(which is the same numeric `.id` for actual `FunctionDef`s).

That similarity tempts authors to treat the spaces as interchangeable.
Don’t.

The important distinction is semantic, not numeric:

- `unitOfNode(id)` means "which innermost unit contains this node?"
- `unitOfFunctionId(id)` means "which unit is owned by this scope identity?"

Those are often, but not universally, the same query.

Use the one that states your intent.

---

## 9. Units and lambdas

Current topology is explicit about what it does and does not own.

Today:

- `FunctionRegistry` knows about `FunctionDef`, `Lambda`, `MultiLambda`;
- units currently correspond to `FileInput` and `FunctionDef` bodies.

That means some structure is function-registered but not yet unit-owned.
This is a good example of a boundary that should stay documented rather than
papered over with generic vocabulary.

---

## 10. Rebuild and retirement semantics

Topology has one writer: the worklist.

It updates topology on:

- mint
- rebuild
- retire

That matters because many consumers rely on topology being valid during these
lifecycle transitions.

Example:

- retire effects walk `nodesOfUnit(unit)` before the unit's indices are dropped.

If you see code manually mutating topology-like maps outside the worklist, that
is almost certainly a smell.

---

## 11. Common mistakes

### Mistake 1: using the numerically convenient id instead of the semantically right space

This is how authors accidentally call `unitOfNode` where `unitOfFunctionId` was
needed, or vice versa.

### Mistake 2: ad hoc AST walks for data topology already owns

If topology can answer it, prefer topology.

### Mistake 3: storing the same bridge in multiple places

Duplicated node->block or node->unit maps drift on rebuild.

### Mistake 4: hiding key-space crossings

A crossing buried in unrelated code is harder to review than one written
explicitly in an edge or helper.

---

## 12. Practical recipes

### Need an expr fact from a node id?
Use `readExprFact(...)` or `TransformFactView.readExprFact(...)`.

### Need the owning unit for a node observation?
Use `topology.unitOfNode(nodeId)`.

### Need the owning unit for a function summary?
Use `topology.unitOfFunctionId(functionId)`.

### Need to evict all per-node facts for a retired unit?
Use `topology.nodesOfUnit(unit)`.

### Need a new crossing repeatedly in many places?
Consider whether topology or a helper layered on topology should own it.

---

## 13. What to read in code

- `src/specialization/framework/topology.ts`
- `src/specialization/framework/key-spaces.ts`
- `src/specialization/framework/dfa-factory.ts`
- `src/specialization/framework/worklist.ts`
- `src/specialization/dfa-query.ts`
- `src/specialization/transforms/memoization.ts`

---

## 14. Short checklist

- [ ] What key space does this thing naturally belong to?
- [ ] Is the crossing I need already owned by topology?
- [ ] Am I using `unitOfNode` vs `unitOfFunctionId` intentionally?
- [ ] Am I duplicating a bridge the topology layer already owns?
- [ ] Would a reviewer be able to see the key-space crossing clearly?

If not, the design is probably harder to read than it needs to be.
