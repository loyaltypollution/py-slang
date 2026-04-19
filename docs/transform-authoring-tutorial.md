# Writing transforms in the specialization framework

This note is for **transform authors**.

If `docs/dfa-framework-tutorial.md` is the "how to write an analysis" guide,
this file is the matching "how to write a transform that consumes analysis
results" guide.

For the full role-based guide set, see `docs/specialization-author-guides.md`.

It explains:

- what a transform is in this codebase;
- what information it is allowed to read;
- how to wire a transform so it reruns when relevant facts change;
- how to mutate ASTs safely;
- what mistakes future authors are most likely to make.

---

## 1. What a transform is

A transform is an **imperative AST rewrite pass**.

It is **not** an `Analysis<K, V>`:

- no lattice;
- no `transfer(ctx, key)`;
- no owned analysis store;
- no participation in the analysis fixpoint protocol.

Instead, a transform is a `TransformRule`:

```ts
export interface TransformRule {
  readonly id: symbol;
  readonly debugName: string;
  readonly edges?: ReadonlyArray<FactEdge<Unit>>;
  readonly autoDirtyOn?: ReadonlyArray<"mint" | "rebuild">;
  sweep(unit: Unit, facts: TransformFactView): boolean;
}
```

The worklist runs analyses to a fixpoint first. Then it sweeps every dirty
transform over the relevant units.

If `sweep(...)` returns `true`, the worklist rebuilds that unit's CFG.

So the lifecycle is:

```text
analyses converge -> transform sweeps -> rewritten units rebuild -> analyses rerun
```

That means transforms consume settled facts; they do not produce them through
analysis transfer.

---

## 2. The most important rule: transforms are ROOT-only

Transforms make **permanent AST rewrites**.

Because of that, they must read only **ROOT** facts: facts that remain valid
without speculative assumptions.

Transforms intentionally receive a restricted read surface:

```ts
export interface TransformFactView {
  read<K, V>(analysis: Analysis<K, V>, key: K): V;
  tryRead<K, V>(analysis: Analysis<K, V>, key: K): V | undefined;
  readAll<K, V>(analysis: Analysis<K, V>): ReadonlyMap<K, V>;
  readExprFact<L>(analysis: BlockFixpointAnalysis<L>, nodeId: number): L | undefined;
}
```

Every one of those reads is bound to `ROOT_CONTEXT`.

### Why?

Because speculative facts are retractable.

For example, guarded compilation may temporarily know:

- "at this call site, `x` looked like an int"
- "this branch predicate looked constant under the current assumptions"

Those are fine for guarded code generation, because the runtime can deopt.
They are **not** fine for unconditional AST rewrites, because an AST rewrite
cannot automatically un-happen when speculation is widened later.

So the contract is:

> If a fact might disappear after deopt or speculation widening, it must not
> justify an unconditional transform.

---

## 3. Which read surface should a transform use?

Use only the `facts` parameter passed into `sweep(...)`.

### Safe reads

#### A. Unit- or scope-keyed facts

```ts
const hot = facts.read(runtimeCallAnalysis, fd.id);
const pure = facts.read(purityScopeAnalysis, fd.id);
```

#### B. Per-expression facts from block DFA analyses

```ts
const constVal = facts.readExprFact(constAnalysis, expr.id);
const typeVal = facts.readExprFact(typeAnalysis, expr.id);
```

This is the normal way to read per-node DFA facts inside an expression or
statement visitor.

### Avoid

Do **not** reach around the transform surface with:

```ts
analysis.store.read(key, someContext)
analysis.store.tryRead(key, someContext)
readExprFact(topology, analysis, nodeId, someContext)
speculativeTypeOf(...)
speculativeConstOf(...)
```

Those are framework-internal or guarded-backend surfaces, not transform-safe
surfaces.

---

## 4. The easiest way to write a transform: `unitSweepRule(...)`

Most transforms in this repo are unit-local AST sweeps. Use the helper:

```ts
export function unitSweepRule(
  name: string,
  sweep: (unit: Unit, facts: TransformFactView) => boolean,
  edges: ReadonlyArray<FactEdge<Unit>> = [],
): TransformRule
```

Example skeleton:

```ts
import type { Unit } from "../framework/function-unit";
import { unitSweepRule, type TransformFactView } from "../framework/transform-rule";
import { someAnalysis } from "../framework/some-analysis";
import type { BasicBlock } from "../framework/cfg";

export const myTransformRule = unitSweepRule(
  "myTransformRule",
  (unit: Unit, facts: TransformFactView) => {
    let changed = false;

    // mutate unit.body here
    // read facts only through `facts`

    return changed;
  },
  [
    {
      on: "fact",
      analysis: someAnalysis.facts,
      wake: (_ctx, block) => [(block as BasicBlock).unit],
    },
  ],
);
```

That last edge means:

- when `someAnalysis.facts` changes for a block,
- mark that block's owning unit dirty,
- and rerun this transform on that unit after the queue settles.

---

## 5. A minimal example: constant-based rewrite

Suppose you want to rewrite:

```python
if True:
    body
else:
    other
```

into just the taken branch whenever the condition is known constant.

This is the same pattern as `src/specialization/transforms/dead-branch.ts`.

```ts
import { StmtNS } from "../../ast-types";
import type { BasicBlock } from "../framework/cfg";
import { constAnalysis } from "../framework/dfa-analyses";
import type { Unit } from "../framework/function-unit";
import { unitSweepRule, type TransformFactView } from "../framework/transform-rule";

class DeadBranchVisitor implements StmtNS.Visitor<void> {
  changed = false;

  constructor(private readonly facts: TransformFactView) {}

  sweep(stmts: StmtNS.Stmt[]): void {
    let i = 0;
    while (i < stmts.length) {
      const stmt = stmts[i];
      if (stmt instanceof StmtNS.If) {
        const cv = this.facts.readExprFact(constAnalysis, stmt.condition.id);
        if (cv?.tag === "const" && typeof cv.value === "boolean") {
          stmts.splice(i, 1, ...(cv.value ? stmt.body : (stmt.elseBlock ?? [])));
          this.changed = true;
          continue;
        }
      }
      stmt.accept(this);
      i++;
    }
  }

  visitIfStmt(stmt: StmtNS.If): void {
    this.sweep(stmt.body);
    if (stmt.elseBlock) this.sweep(stmt.elseBlock);
  }

  visitFileInputStmt(stmt: StmtNS.FileInput): void {
    this.sweep(stmt.statements);
  }

  visitWhileStmt(stmt: StmtNS.While): void { this.sweep(stmt.body); }
  visitForStmt(stmt: StmtNS.For): void { this.sweep(stmt.body); }
  visitFunctionDefStmt(_stmt: StmtNS.FunctionDef): void {}
  visitAssignStmt(_stmt: StmtNS.Assign): void {}
  visitAnnAssignStmt(_stmt: StmtNS.AnnAssign): void {}
  visitReturnStmt(_stmt: StmtNS.Return): void {}
  visitSimpleExprStmt(_stmt: StmtNS.SimpleExpr): void {}
  visitAssertStmt(_stmt: StmtNS.Assert): void {}
  visitPassStmt(_stmt: StmtNS.Pass): void {}
  visitBreakStmt(_stmt: StmtNS.Break): void {}
  visitContinueStmt(_stmt: StmtNS.Continue): void {}
  visitGlobalStmt(_stmt: StmtNS.Global): void {}
  visitNonLocalStmt(_stmt: StmtNS.NonLocal): void {}
  visitFromImportStmt(_stmt: StmtNS.FromImport): void {}
}

export const deadBranchRule = unitSweepRule(
  "deadBranchRule",
  (unit: Unit, facts: TransformFactView) => {
    const visitor = new DeadBranchVisitor(facts);
    visitor.sweep(unit.body);
    return visitor.changed;
  },
  [{ on: "fact", analysis: constAnalysis.facts, wake: (_ctx, block) => [(block as BasicBlock).unit] }],
);
```

### What this example shows

1. The transform is **unit-local**.
2. It reads a **per-expression** fact with `facts.readExprFact(...)`.
3. It rewrites the AST in place.
4. It returns `true` iff it changed the unit.
5. It subscribes to the **facts analysis that justifies the rewrite**.

---

## 6. Another common pattern: whole-function transforms

Not every transform is about individual expressions.

`src/specialization/transforms/memoization.ts` is a good model for a
whole-function transform:

- read unit- or function-keyed facts like call counts and purity;
- check a precondition at the top of `sweep(...)`;
- if the function body is eligible, wrap or rewrite it.

The pattern looks like this:

```ts
export const someFunctionTransform = unitSweepRule(
  "someFunctionTransform",
  (unit, facts) => {
    const fd = unit.funcAst;
    if (!(fd instanceof StmtNS.FunctionDef)) return false;

    const hot = facts.read(runtimeCallAnalysis, fd.id);
    const pure = facts.read(purityScopeAnalysis, fd.id);
    if (hot < THRESHOLD) return false;
    if (pure !== true) return false;

    // mutate function body
    return true;
  },
  [
    { on: "fact", analysis: runtimeCallAnalysis, wake: (ctx, functionId) => {
      const unit = ctx.topology.unitOfFunctionId(functionId as number);
      return unit ? [unit] : [];
    }},
    { on: "fact", analysis: purityScopeAnalysis, wake: (ctx, functionId) => {
      const unit = ctx.topology.unitOfFunctionId(functionId as number);
      return unit ? [unit] : [];
    }},
  ],
);
```

Notice that the edge `wake(...)` function is where you bridge from the
upstream analysis key-space into the transform's key-space, which is `Unit`.

---

## 7. Choosing the right upstream edge

A transform should subscribe to the **smallest fact surface that actually
justifies the rewrite**.

For paired block DFA analyses, that often means subscribing to `.facts`, not
`.env`.

Why?

- `.env` may change without producing a new per-node fact used by the
  transform.
- `.facts` is usually the direct surface the transform reads through
  `facts.readExprFact(...)`.

That is why `constant-folding`, `dead-branch`, and `algebraic-simplify`
subscribe to fact changes on the relevant `.facts` analyses.

A good rule of thumb:

> Subscribe to the analysis cell your transform conceptually reads.

---

## 8. Idempotency: your rewrite must make its own precondition fail

Transforms may run multiple times:

- after initial analysis convergence;
- after a unit rebuild;
- after upstream facts advance.

So a transform should be **idempotent**.

That usually means the rewrite removes the pattern it matched.

Examples:

- constant folding replaces `Binary(...)` with `Literal(...)`, so the same
  node will not match again;
- dead-branch elimination removes the `If`, so the same branch cannot be
  eliminated twice;
- memoization detects whether the memo prelude is already present.

Bad transform shape:

```ts
// Every run prepends another wrapper.
fd.body.unshift(makeHelperStmt());
return true;
```

Good transform shape:

```ts
if (hasHelperPrelude(fd)) return false;
fd.body.unshift(makeHelperStmt());
return true;
```

---

## 9. Returning `true` means "CFG rebuild required"

If your transform mutated `unit.body`, return `true`.

That tells the worklist to rebuild the unit's CFG and rerun affected analyses.

If your transform examined the AST but made no structural change, return
`false`.

Do not manually trigger the rebuild from transform code; that is the
worklist's job.

---

## 10. How to walk the AST

Most existing transforms use a local visitor class and mutate in place.
That is the recommended style here because it keeps:

- rewrite state (`changed`);
- fact access (`facts`);
- recursive traversal;
- helper predicates;

all in one place.

Typical expression-rewrite skeleton:

```ts
class MyExprVisitor implements ExprNS.Visitor<ExprNS.Expr> {
  changed = false;

  constructor(private readonly facts: TransformFactView) {}

  rewrite(expr: ExprNS.Expr): ExprNS.Expr {
    return expr.accept(this);
  }

  visitBinaryExpr(expr: ExprNS.Binary): ExprNS.Expr {
    expr.left = expr.left.accept(this);
    expr.right = expr.right.accept(this);

    const fact = this.facts.readExprFact(someAnalysis, expr.id);
    if (canRewrite(expr, fact)) {
      this.changed = true;
      return makeReplacement(expr, fact);
    }
    return expr;
  }

  // other visit methods...
}
```

Typical statement sweep skeleton:

```ts
class MyStmtVisitor implements StmtNS.Visitor<void> {
  changed = false;
  private readonly exprVisitor: MyExprVisitor;

  constructor(facts: TransformFactView) {
    this.exprVisitor = new MyExprVisitor(facts);
  }

  private rewriteExpr(expr: ExprNS.Expr): ExprNS.Expr {
    const out = this.exprVisitor.rewrite(expr);
    if (this.exprVisitor.changed) {
      this.changed = true;
      this.exprVisitor.changed = false;
    }
    return out;
  }

  visitAssignStmt(stmt: StmtNS.Assign): void {
    stmt.value = this.rewriteExpr(stmt.value);
  }
}
```

---

## 11. Safety checklist before you commit a transform

### Fact-safety

- [ ] Every fact read goes through the `facts` parameter.
- [ ] No direct `analysis.store.read(..., context)` calls in the transform.
- [ ] No speculative query API (`speculativeTypeOf`, `speculativeConstOf`, etc.).
- [ ] The rewrite is justified by ROOT facts only.

### Scheduling

- [ ] `edges` mention the upstream analyses whose fact changes matter.
- [ ] `wake(...)` maps upstream keys to `Unit`s correctly.
- [ ] The transform subscribes to the narrowest useful fact surface.

### Rebuild / idempotency

- [ ] `sweep(...)` returns `true` iff it really mutated `unit.body`.
- [ ] Re-running the transform does not stack duplicate rewrites.
- [ ] The rewrite removes its own precondition, or an explicit guard prevents repetition.

### Structure

- [ ] Nested functions are handled deliberately, not accidentally.
- [ ] If the transform changes function structure, it follows the registry contract below.

---

## 12. Special warning: transforms that add or remove functions

Most transforms only rewrite expressions/statements inside an existing unit.
That is the easy case.

If you add or remove a `FunctionDef`, `Lambda`, or `MultiLambda`, you must also
cooperate with the function registry.

See `src/specialization/framework/interfaces.ts`.

Required steps:

1. populate `functionEnvironments` for the new node, if adding;
2. call `registry.mint(newNode)` or `registry.retire(oldNode.id)`.

Why this matters:

- function identity and slot layout are owned by `FunctionRegistry`;
- the worklist and compiler consume that registry;
- if you mutate function structure without updating the registry, you create a
  stale unit/slot mapping.

So structural function transforms are a separate, higher-care class of change.
If your transform does not add/remove functions, you can ignore this section.

---

## 13. What mistakes future authors usually make

### Mistake 1: reading speculative facts because they seem "more precise"

Tempting but wrong:

```ts
const spec = dfaQuery.speculativeConstOf(expr.id);
if (spec?.tag === "const") {
  // rewrite AST
}
```

Why wrong: the AST change is permanent, but the speculative fact is not.

Correct approach: only read through `facts.readExprFact(...)` or other
root-only `TransformFactView` methods.

### Mistake 2: subscribing to a broad upstream surface

Tempting:

```ts
edges: [{ on: "fact", analysis: typeAnalysis.env, ... }]
```

But if the transform actually consumes per-node facts, `.facts` is usually the
better trigger.

### Mistake 3: non-idempotent rewrites

If the transform prepends/appends wrappers every time it runs, rebuild cycles
will duplicate them.

### Mistake 4: forgetting nested-unit boundaries

When a nested `FunctionDef` owns its own unit, do not keep descending into it
unless the transform is intentionally crossing that boundary.

Existing transforms usually treat nested functions as "their own unit handles
this."

---

## 14. Where to look for examples

Good real transforms in this repo:

- `src/specialization/transforms/constant-folding.ts`
- `src/specialization/transforms/dead-branch.ts`
- `src/specialization/transforms/algebraic-simplify.ts`
- `src/specialization/transforms/dead-store.ts`
- `src/specialization/transforms/memoization.ts`

Relevant framework contracts:

- `src/specialization/framework/analysis.ts`
- `src/specialization/framework/transform-rule.ts`
- `src/specialization/framework/worklist.ts`
- `src/specialization/framework/interfaces.ts`
- `src/specialization/dfa-query.ts`

Boundary / architecture notes:

- `docs/fact-surfaces-and-speculation.md`
- `docs/must-analysis-review.md`

---

## 15. Short recipe

If you just want the checklist version:

1. Decide whether the rewrite is really a transform, not an analysis.
2. Implement it as a `unitSweepRule(...)` unless you need a custom `TransformRule`.
3. Read facts only through `TransformFactView`.
4. Use `facts.readExprFact(...)` for per-expression DFA facts.
5. Add `edges` that wake the owning `Unit` when the relevant upstream facts advance.
6. Make the rewrite idempotent.
7. Return `true` only when `unit.body` actually changed.
8. If you add/remove functions, update the function registry too.

That is the transform-author contract in this codebase.
