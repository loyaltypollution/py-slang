# Specialization framework — lock down the view contract

## Goal

The routing layer is already clear:

- `NodeId` is the atomic program address.
- `NodeSet` is the routing primitive.
- `intersects(delta, interest)` is the dispatch rule.
- `Analysis<K extends NodeSet, V>` is the right generic shape.

What is unclear is the **view layer**. Today the code uses “view” for multiple different things:

- concrete program regions (`Function`, `BasicBlock`)
- a program-wide lookup surface (`FunctionView`)
- a lifecycle/policy owner (`FunctionViewManager`)

That naming collision is the source of most of the confusion. This plan fact-checks the current architecture, locks down the contracts, and stages the cleanup.

---

## Fact-checked current state

### What is a node?

A node is a `NodeId`: an AST expression/statement id used for routing and facts.

Source: `src/specialization/program/node-set.ts`

### What is a node-set?

A `NodeSet` is only a membership contract:

- `contains(nodeId)`
- optional `size`
- optional `iterate()`

It exists for dispatch and analysis-key geometry. It does **not** imply lifecycle, ownership, identity, or lookup.

Source: `src/specialization/program/node-set.ts`

### What are the actual view objects today?

The real view-like objects are:

- `Function`
- `BasicBlock`

Both already implement the `NodeSet` shape and carry kind-specific structure.

Sources:
- `src/specialization/program/views/function.ts`
- `src/specialization/program/views/basic-block.ts`

### What is `FunctionView` today?

`FunctionView` is **not** a view object. It is a program-wide lookup interface:

- `functions: ReadonlyMap<FunctionId, Function>`
- `functionOfNode(nodeId)`

Source: `src/specialization/program/views/function-view.ts`

This is the main terminology bug.

### What is `FunctionViewManager` today?

`FunctionViewManager` is doing several jobs at once:

- function registry / lookup
- node-to-function indexing
- mint / rebuild lifecycle
- structural addition and rebuild flush
- future-dispatch context storage
- refutation reconciliation

Source: `src/specialization/program/views/function-view-manager.ts`

This is the main architectural seam.

### What is function-shaped in the framework today?

These are all true today:

- `ProgramCtx extends FunctionView`
- analyses cast with `asProgramCtx(ctx)` to recover function lookups
- `TransformRule` is generic in signature, but `Worklist` dirties and sweeps `Function`
- `Worklist` itself exposes `functions`, `functionOfNode`, `futureDispatchChainForNode`
- `dfa-query.ts` duck-types extra “future dispatch” capability on top of `FunctionView`

Sources:
- `src/specialization/program/program-ctx.ts`
- `src/specialization/framework/worklist.ts`
- `src/specialization/dfa-query.ts`
- `src/specialization/framework/analysis.ts`

### What in the earlier sketch was right?

Right:

- internal structural relations should prefer references over id-then-lookup where possible
- `BasicBlock.unitId` is an avoidable foreign key
- the `asProgramCtx` cast layer is a leak
- a real `View` contract is missing
- lifecycle/lookup/policy need to be separated

### What in the earlier sketch needs correction?

Also true after reading the code:

1. **Not every id should disappear.**
   `FunctionId` and `ParamKey` are legitimate runtime / observation boundary identities. They are used by JIT ingress, counters, channels, and `AssumptionChain` keys. They should stay at those boundaries.

2. **The “five lookup sites” list understates the seam.**
   The function-shaped dependency is broader: transfer helpers, purity, narrowing bindings, transforms, JIT observers, and DFA queries all rely on the same registry surface.

3. **`ProgramCtx` should not be deleted until consumers have explicit replacements.**
   The cast layer is bad, but some consumers genuinely need program-shape lookup. The plan must first give them narrower locators/managers.

4. **A generic `View` interface should be minimal.**
   The code does not justify forcing every view to expose a generic `id` or `kind` field. The useful contract is: a view is a concrete program region that implements `NodeSet`; concrete subtypes carry their own structure.

---

## Locked-down contracts

## Node

**Responsibility**
- atomic AST address for routing and node facts

**Consumed by**
- fact maps
- singleton-node subscriptions
- view membership

---

## NodeSet

**Responsibility**
- membership and intersection for dispatch

**Consumed by**
- analysis keys
- `ctx.write(..., delta)`
- `Worklist.subscribe(..., interest)`

**Must not own**
- lifecycle
- rebuild
- global lookup
- speculation policy

---

## View

A **View** is a concrete program region that implements `NodeSet` and has stable identity by object reference.

Current views:
- `Function`
- `BasicBlock`

Future views may include:
- `Loop`
- `Region`

**A view should offer**
- `NodeSet` membership
- kind-specific structure and direct relations to nearby views

**A view should not offer**
- global registries (`functions`, `functionOfNode`)
- lifecycle subscriptions
- rebuild scheduling
- speculation/refutation policy unless that policy is intrinsic to that concrete kind

Important: **not every `NodeSet` is a view**. Singleton-node sets, `EMPTY_NODESET`, and `ANY_NODESET` are routing helpers, not program views.

---

## View manager

A **ViewManager<V extends View>** owns program-wide concerns for one view kind:

- registry / iteration of existing views
- node-to-view indexing when applicable
- mint / rebuild lifecycle
- kind-specific build / rebuild logic

A manager is the right place for global lookups. A view object is not.

---

## Boundary identities

These stay even after the refactor:

- `FunctionId` at runtime/JIT boundaries
- `ParamKey` for observation / narrowing axes

Reason: these are not structural relations inside the IR. They are stable external identities used by observation channels, counters, and assumption keys.

---

## Core diagnosis

The codebase currently overloads one term, “view”, across three roles:

1. **view object** — `Function`, `BasicBlock`
2. **lookup service** — `FunctionView`
3. **manager/policy owner** — `FunctionViewManager`

That overload causes four concrete problems:

1. **Misleading naming**
   A future reader sees `FunctionView` and reasonably expects a function-shaped view object. Instead it is a registry.

2. **Leaky privilege**
   Consumers that only need a narrow lookup surface receive `Worklist` or cast `AnalysisCtx` to recover more power than they need.

3. **False genericity**
   The framework claims generic `TransformRule<V, P>`, but the actual dirtying, lifecycle, and sweep path are still `Function`-specific.

4. **Hard-to-extend view layer**
   Adding a new analysis is obvious because the lattice/store/transfer split is explicit. Adding a new view kind is confusing because the view/registry/manager boundaries are not.

---

## Architectural direction

### 1. Keep the routing model

Do **not** change:

- `NodeId`
- `NodeSet`
- `intersects`
- `Analysis<K extends NodeSet, V>`
- delta-routed subscriptions

That layer is already the clearest part of the subsystem.

### 2. Formalize “view” as a minimal marker contract

Add `program/views/view.ts`:

```ts
export interface View extends NodeSet {}
```

This is intentionally minimal. Its job is to distinguish real program regions from arbitrary routing-only `NodeSet`s.

Concrete types provide the useful structure:

- `Function extends View`
- `BasicBlock extends View`

### 3. Prefer direct references for structural relations

Use references for internal IR/view relationships when the producer already has the object in hand.

Good candidate now:

- `BasicBlock.unitId -> unit: Function`

Do **not** force this onto runtime/observation identities. `FunctionId` and `ParamKey` remain boundary keys.

### 4. Move program-wide lookup onto managers

Rename the misnamed registry surface:

- `FunctionView` -> `FunctionRegistry` (or delete it in favor of `FunctionManager` methods)
- `FunctionViewManager` -> `FunctionManager`

Rule: if an operation says “find the owning function/block for X”, it belongs on a manager/registry, not on a view.

### 5. Replace cast-based access with explicit dependencies

Consumers that genuinely need program shape should receive a narrow manager/locator explicitly.

Examples:
- block / function lookup by node id
- function lookup by `FunctionId`
- function lookup by AST scope node

After all such consumers are migrated, delete `ProgramCtx` and `asProgramCtx`.

### 6. Make framework generic over view managers, not function names

The framework should know about:
- `View`
- `ViewManager<V>`
- manager-driven lifecycle iteration

It should not hard-code `Function` where a generic view/manager pair would do.

### 7. Keep speculation policy function-specific until a second host exists

Today only `Function` carries future-dispatch policy. Do not invent a premature generic `DispatchHost` hierarchy unless another kind actually needs it.

But do split it from raw registry/lifecycle plumbing so the boundary is explicit.

---

## Migration plan

Each phase: `tsc` clean, tests green, one commit.

## Phase 0 — terminology cleanup with no behavior change

### Changes
- Add `src/specialization/program/views/view.ts` with minimal `View extends NodeSet`.
- Update comments to say explicitly:
  - `Function` and `BasicBlock` are view objects.
  - `FunctionView` is a registry surface, not a view object.
- Rename for clarity:
  - `FunctionView` -> `FunctionRegistry`
  - `FunctionViewManager` -> `FunctionManager`

### Why first
This removes the biggest source of reader confusion before any semantic work.

### Acceptance
- No file uses “view” to mean “global function table”.
- Comments state the contracts above.

---

## Phase 1 — replace structural foreign keys with references

### Changes
- `BasicBlock.unitId: FunctionId` -> `unit: Function`
- update CFG builder and all call sites that currently do `functions.get(block.unitId)`
- helper methods read `block.unit.funcAst.id` when a boundary id is still needed

### Sites simplified immediately
- `analysis/dfa-factory.ts`
- `analysis/purity/analysis.ts`
- `program/views/function-resolver.ts` or its replacement
- stale-block eviction helpers that compare by owner

### Acceptance
- No internal structural code needs `functions.get(block.unitId)`.
- `BasicBlock` owns a direct pointer to its containing function.

---

## Phase 2 — keep runtime/observation ids explicit

### Changes
- Keep `FunctionId` as the runtime scope id.
- Keep `ParamKey = \`${FunctionId}:${number}\``.
- Audit comments and code so these ids are clearly documented as **boundary keys**, not evidence that views themselves should be id-lookup-driven.

### Explicit non-change
- Do **not** convert `ParamKey` to hold a `Function` reference in this pass.
- Do **not** remove `FunctionId` from JIT/counter/channel APIs.

### Why
Those ids are legitimate at ingress and in `AssumptionChain` bindings.

### Acceptance
- Boundary-id use is explicit and documented.
- Internal view relations use references where available; runtime ingress still uses ids.

---

## Phase 3 — introduce explicit locators/managers, then remove cast layer

### Changes
Create narrow lookup capabilities on `FunctionManager` (or thin helpers over it), for example:

- `functionById(functionId)`
- `functionContainingNode(nodeId)`
- `blockContaining(nodeId)`
- `functionForAst(funcAst)`

Migrate current `asProgramCtx` consumers to explicit dependencies:

- `analysis/dfa-factory.ts`
- `analysis/purity/analysis.ts`
- `narrowing-policy/param-handles.ts`
- `analysis/type-requirement/analysis.ts`
- `observation/runtime-analyses.ts`
- `observation/jit-dispatch.ts`
- `dfa-query.ts`

Then delete:

- `program/program-ctx.ts`
- `asProgramCtx(...)`
- `program/views/function-view.ts` (after rename/shim removal)
- `program/views/function-resolver.ts` if its logic is absorbed by managers/locators
- `Worklist` convenience forwarders like `functions` / `functionOfNode`

### Why staged
The cast is bad, but some code genuinely needs lookup. Give it an explicit owner first.

### Acceptance
- No `asProgramCtx(...)` remains.
- No analysis/transform relies on `ProgramCtx extends FunctionView`.
- Every remaining global lookup is visibly owned by `FunctionManager` or a narrow locator.

---

## Phase 4 — extract generic `ViewManager<V extends View>`

### Changes
Extract the common lifecycle/indexing shell from `FunctionManager`:

```ts
interface ViewManager<V extends View> {
  values(): Iterable<V>;
  onMint(cb: (view: V) => void): void;
  onRebuild(cb: (view: V) => void): void;
}
```

`FunctionManager` then becomes:

- `ViewManager<Function>`
- plus function-specific build/rebuild/index helpers
- plus function-specific boundary lookups that remain legitimate (`functionById`, `functionForAst`, etc.)

### Worklist changes
- `Worklist` stores/manages view managers explicitly instead of one hard-coded function manager field.
- generic lifecycle loops stop naming `Function` directly.

### Acceptance
- framework code no longer mentions `Function` where only view-lifecycle concepts are needed.
- function-specific knowledge is pushed to `FunctionManager` and boundary glue.

---

## Phase 5 — split speculation policy from raw registry/lifecycle plumbing

### Current fact
`futureDispatchContextByUnit` and refutation reconciliation are currently housed in `FunctionViewManager`.

### Changes
Make the function-specific speculation surface explicit. Two valid shapes are acceptable:

1. keep it on `FunctionManager` as clearly separated function-policy state, or
2. move it onto `Function` / a `FunctionDispatchState` owned by the manager

Do this only after the generic manager extraction, so the split is visible.

### Explicit non-goal
Do **not** add a generic `DispatchHost` trait unless a second view kind actually needs it.

### Acceptance
- speculation policy is no longer conflated with generic registry/lifecycle code
- `dfa-query.ts` stops duck-typing “future dispatch” off a registry interface

---

## Phase 6 — finish transform/query cleanup

### Changes
- `TransformRule<V extends View>` registers against the relevant `ViewManager<V>`
- dirty sets become `Set<V>` rather than `Set<Function>` in the generic framework path
- transforms receive only the read/query capabilities they need, not full `Worklist`
- DFA query helpers take explicit locators and explicit future-dispatch callbacks, not a misnamed registry object

### Why
This removes the remaining “generic in type parameter, function-shaped in practice” mismatch.

### Acceptance
- a hypothetical `LoopManager` and `TransformRule<Loop>` can be introduced without framework surgery
- transforms cannot accidentally depend on unrelated `Worklist` powers

---

## Tests and invariants to add or preserve

### Preserve
- `BasicBlock.nodeIds` = exclusive CFG ownership
- enclosing `Function` excludes nested function-body nodes
- synthetic CFG blocks have empty `nodeIds`

Existing coverage:
- `src/tests/specialization/node-set.test.ts`

### Add
1. `BasicBlock.unit` survives rebuilds and always points at the owning function.
2. manager lookups (`functionById`, `functionContainingNode`, `blockContaining`) agree with direct references.
3. runtime observation ids (`FunctionId`, `ParamKey`) still route to the same owning function after the refactor.
4. no transform is handed full `Worklist` unless it truly needs it.
5. `dfa-query` future-dispatch access is explicit rather than duck-typed.

---

## Out of scope

- actually adding `Loop` / `Region` views
- a generic cross-kind containment lattice
- removing legitimate runtime boundary ids
- redesigning the routing layer (`NodeSet`, `intersects`, analysis keys)

---

## End state

After this plan lands, the architecture should read cleanly:

- `NodeId` = atomic address
- `NodeSet` = routing geometry
- `View` = concrete program region (`Function`, `BasicBlock`, ...)
- `ViewManager<V>` = global lifecycle/index/lookup for one view kind
- runtime ids (`FunctionId`, `ParamKey`) = boundary keys only

And most importantly:

- views are easy to define
- managers are easy to find
- lookups are explicit
- transforms/analyses no longer smuggle “function registry” through a type called `FunctionView`
- adding a new view kind follows a visible recipe instead of cargo-culting function-specific code
