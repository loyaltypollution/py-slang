# Writing transforms that add or remove functions

Most transforms in this codebase rewrite expressions or statements inside an
existing unit.

This guide is for the rarer, higher-care case:

> transforms that add or remove `FunctionDef`, `Lambda`, or `MultiLambda`
> structure.

The theory first:

Function structure is not just AST shape. It is also:

- function identity;
- bytecode slot layout;
- unit lifecycle;
- topology membership.

That is why this case has a stronger contract.

---

## 1. Theory: function structure has external owners

A structural function rewrite is different from a local expression rewrite.

Why?

Because function-bearing nodes are consumed by systems outside the AST itself:

- `FunctionRegistry` owns function identity and slot layout;
- the worklist owns unit mint/rebuild/retire lifecycle;
- topology owns cross-unit indexing;
- evaluators/backends consume registry and topology state.

So adding/removing a function is not just "change the tree and return true".
It is a coordinated state change.

---

## 2. The contract in one sentence

If a transform adds or removes a scope-owning function node, it must update the
`FunctionRegistry` so the worklist can mint/retire the corresponding unit.

The current contract is documented in:

- `src/specialization/framework/interfaces.ts`
- `src/specialization/framework/function-registry.ts`

---

## 3. What the registry owns

`FunctionRegistry` is the canonical owner of:

- `functionId -> node`
- `functionId -> slot`
- node registration status

It assigns slots monotonically at `mint(...)` time and never reuses them within
one registry instance.

That means a structural transform must not try to fake registration by mutating
some local slot map.

---

## 4. The required steps when adding a function

If your transform adds a new `FunctionDef` / `Lambda` / `MultiLambda`:

1. populate `functionEnvironments` for the new node;
2. call `registry.mint(newNode)`.

Why that order?

Because the worklist's registry listener may immediately build the new unit and
related structures when `mint(...)` fires. The environment data must exist first.

Sketch:

```ts
// 1. prepare resolver/environment data for the new node
functionEnvironments.set(newNode, newEnv);

// 2. register identity + slot + lifecycle
registry.mint(newNode);

// 3. enclosing sweep still returns true so its own unit rebuilds
return true;
```

---

## 5. The required steps when removing a function

If your transform removes an existing scope-owning node:

1. remove the AST structure;
2. call `registry.retire(oldNode.id)`;
3. return `true` so the enclosing unit rebuilds.

Sketch:

```ts
removeNodeFromAst(oldNode);
registry.retire(oldNode.id);
return true;
```

The worklist listener handles the downstream lifecycle.

---

## 6. What `mint` / `retire` trigger downstream

The registry itself is intentionally small. It does not know the whole worklist.
It only emits structural events to its listener.

The owning worklist then handles:

- unit mint / retire
- topology updates
- lifecycle dispatch to analyses and transforms

That split is good. Keep it.

Registry answers "what happened to function identity?"
Worklist answers "what engine structures must react?"

---

## 7. What you do **not** need to do manually

If your transform returns `true`, the worklist will rebuild the enclosing unit's
CFG automatically.

So do **not** manually:

- rebuild the enclosing unit CFG;
- patch topology maps yourself;
- enqueue lifecycle events yourself.

That is all worklist-owned.

---

## 8. Why silent failure here is dangerous

A missed registry update creates divergence between:

- the AST you can see,
- the function registry,
- unit/topology state,
- and backend slot layout.

That is a classic silent-miscompile shape.

The current code tries to convert this into a loud throw as early as possible:

- `FunctionRegistry` throws on missing or duplicate registration;
- slot lookups fail noisily.

That is good defensive design. The right response is still to follow the
contract, not to work around the throw.

---

## 9. When a transform should probably not do this at all

A transform that adds/removes function structure is high-friction by nature.
Before doing it, ask:

- is this really a transform, or should it happen in parsing/lowering?
- is the new function a real semantic scope, or just a codegen helper?
- can the optimization be expressed without changing function identity?

If the answer is "this is just a helper wrapper for backend convenience", a
backend-local mechanism may be better than a structural AST rewrite.

---

## 10. Nested function boundaries still matter

Even if a transform is allowed to add/remove functions, it should still be clear
about unit ownership.

Typical transforms treat nested functions as:

> this is a separate unit; do not descend unless the transform intentionally
> crosses that boundary.

Structural function transforms should be even more explicit here, because they
change the set of units themselves.

---

## 11. Common mistakes

### Mistake 1: mutating the AST but forgetting `registry.mint(...)` / `retire(...)`

This is the main one.

### Mistake 2: calling `mint(...)` before required environment data exists

Then the new unit may be born with missing analysis inputs.

### Mistake 3: trying to update slot layout manually

Slot ownership belongs to `FunctionRegistry`.

### Mistake 4: manually rebuilding topology/lifecycle state

That duplicates worklist ownership.

### Mistake 5: using structural function rewrites for something that is really backend-local

That inflates the architectural surface unnecessarily.

---

## 12. A practical recipe

If you must add/remove function structure:

1. Decide whether it truly belongs in a transform.
2. Identify every scope-owning node being added/removed.
3. For additions, create `functionEnvironments` first.
4. Call `registry.mint(...)` / `registry.retire(...)` exactly once per affected node.
5. Return `true` so the enclosing unit rebuilds.
6. Add tests covering:
   - registry state
   - topology/unit lifecycle
   - slot lookup
   - repeated/idempotent transform runs

---

## 13. What to read in code

- `src/specialization/framework/interfaces.ts`
- `src/specialization/framework/function-registry.ts`
- `src/specialization/framework/worklist.ts`
- `src/specialization/framework/function-unit.ts`
- `src/tests/specialization/framework/function-registry.test.ts`

---

## 14. Short checklist

- [ ] Does this rewrite really need to add/remove function structure?
- [ ] Have I prepared environment data before `mint(...)`?
- [ ] Did every added node get `registry.mint(...)`?
- [ ] Did every removed node get `registry.retire(...)`?
- [ ] Am I relying on the worklist, not local code, for rebuild/topology/lifecycle handling?
- [ ] Is the transform idempotent across rebuilds?

If any answer is "no", stop and fix that before landing the change.
