# Writing transforms in the specialization framework

This note is for **transform authors**.

If `docs/dfa-framework-tutorial.md` is the "how to write an analysis" guide,
this is the matching "how to consume analysis facts to rewrite the AST" guide.

It explains:

- what a transform is, and what it is *not*;
- the witness-scoped publication model (ROOT vs. non-ROOT bodies);
- how to read facts safely — including the `Reading<V>` / `readMinimal` family;
- how to wire a transform so it reruns when relevant facts advance;
- the mistakes future authors are most likely to make.

---

## 1. What a transform is

A transform is an **imperative AST rewrite pass** that runs after analyses
have settled.

It is **not** an `Analysis<K, V>`:

- no lattice, no `transfer`, no owned analysis store;
- no participation in the analysis fixpoint.

The shape is `TransformRule`:

```ts
export interface TransformRule {
  readonly id: symbol;
  readonly debugName: string;
  readonly edges?: ReadonlyArray<FactEdge<Unit>>;
  readonly autoDirtyOn?: ReadonlyArray<"mint" | "rebuild">;
  readonly contextAware?: boolean;
  sweep(unit: Unit, facts: TransformFactView): boolean;
}
```

The worklist runs analyses to a fixpoint, then sweeps every dirty transform
over its dirty units. If `sweep(...)` returns `true`, the worklist rebuilds
that unit's CFG and the analysis fixpoint reruns.

```text
analyses converge -> transforms sweep -> rewritten units rebuild -> analyses rerun
```

So transforms **consume** settled facts. They never produce facts via
analysis transfer.

---

## 2. The single most important idea: publication is witness-scoped

This is the part of the framework that has changed the most. Read it twice.

### 2.1. Why ROOT vs. non-ROOT bodies exist

A speculative assumption (e.g. "at this call site, `x` is an int") is a
*chain node* — a position in the lattice of ongoing assumptions, with ROOT
sitting at the top (no assumptions).

Some facts are proven only under speculation: they live at non-ROOT chain
nodes and disappear if speculation widens. Other facts are proven without
any assumption: they live at ROOT and are permanent.

A transform that rewrites the AST has to answer one question for every
rewrite it makes: **on which chain node should the rewrite be visible?**

- If the supporting fact is ROOT, the rewrite should land in
  `unit.funcAst.body` — every consumer (every chain node) sees it.
- If the supporting fact only holds under chain node `C`, the rewrite must
  land in a body that is visible to `C` and its descendants, but **not** to
  unrelated chain nodes that never assumed `C`.

That is what the per-(Unit, AssumptionChain) **body store**
(`framework/chain-body-store.ts`) is for. ROOT always owns
`unit.funcAst.body`. Non-ROOT chain nodes own a body **only after a
transform has forked one there** (lazy fork). Lookup at any chain node
walks `chain → ROOT` and returns the first owned body.

### 2.2. The publication contract

Every transform sweep must declare, by construction, which body it is
mutating:

- `facts.bodyAtRoot(unit)` — returns `unit.funcAst.body`. Throws if the
  view is non-ROOT. Use this for ROOT-only rules.
- `facts.bodyAtWitness(unit, reading)` — returns the body at
  `reading.witness`, lazily forking from the nearest owning ancestor on
  first call. The typed `Reading<V>` argument is the surface-level proof
  that you actually read a fact at that witness; you cannot fabricate one.

ROOT is just the trivial case of witness-scoped publication: when
`reading.witness === ROOT_CONTEXT`, `bodyAtWitness` returns
`unit.funcAst.body` — the same array `bodyAtRoot` would.

### 2.3. The `contextAware` flag

`contextAware: true` tells the worklist to bind the transform's `facts`
view at the unit's *active* speculation context instead of ROOT. That
unlocks `readMinimal`-style ancestor walks reaching into non-ROOT
witnesses, and unlocks `bodyAtWitness`.

If your rule mutates **shared AST nodes** (expression nodes, deeply nested
statement-list arrays), leave `contextAware` unset. Shared mutations are
only sound at ROOT — a non-ROOT view could justify a rewrite from a
speculative fact, but the mutated subtree would be reachable from sibling
chain nodes that never assumed it.

In the current codebase, `memoizationRule` is the *only* context-aware
rule. It only rewrites the top-level body array; it never reaches into
shared subtrees. Every other transform stays ROOT-only.

---

## 3. Reading facts: `Reading<V>` and the witness vocabulary

Pre-refactor, transform reads returned a bare value. They now return a
`Reading<V>`:

```ts
interface Reading<V> {
  readonly value: V;     // the proven fact
  readonly witness: AssumptionChain;  // where it was proven
}
```

The witness is the bookkeeping that the publication contract enforces.

### 3.1. The three read styles

For semantic analyses (may/must), the view exposes three shapes:

```ts
read         (analysis, key)         // value at the bound context, ROOT-fallback
readAt       (analysis, key)         // exact-positional Reading at the bound context
readMinimal  (analysis, key, accept) // shallowest ancestor where `accept(value)` holds
```

- `read` is the convenience surface: it returns just the value (no
  witness). Behind the scenes it tries the bound context and falls back to
  ROOT. Use this when the rule is ROOT-bound and you don't care about
  witnesses.
- `readAt` answers *"what does this analysis say at the exact context I'm
  bound to?"* and labels the answer with that exact witness.
- `readMinimal` answers *"what is the **weakest assumption** under which
  this fact holds?"* It walks `current → ROOT` and returns the
  shallowest-ancestor reading whose value satisfies your predicate.
  Unwritten ancestor cells are skipped (they are not implicit ROOT
  fallbacks).

The same trio exists for per-expression DFA reads:
`readExprFact` / `readExprFactAt` / `readExprFactMinimal`.

### 3.2. Why "Minimal"? The pedagogy

"Minimal" means *minimal in assumptions*, not minimal in value. Picture the
chain as a tree, ROOT at the top. The bound context is some leaf. As you
walk leaf → ROOT, you peel off assumptions one at a time. The shallowest
ancestor where the fact still holds is the position where the fact survives
the **most** widening — equivalently, the position with the **fewest**
load-bearing assumptions.

That position is the right witness to publish a rewrite at, because:

- the rewrite then survives any future deopt that widens *any* assumption
  the witness does not depend on;
- sibling chain nodes that share the witness as ancestor inherit the
  rewrite via body-store walk, automatically;
- chain nodes off that ancestor's subtree never see the rewrite, so we
  cannot poison them with an unsound assumption.

So `readMinimal` + `bodyAtWitness` is the pair: read at the weakest
assumption, publish there, and you have just made the strongest
unconditional rewrite the speculative state allowed.

### 3.3. `readProfitability` is not for proof

```ts
readProfitability(analysis, key)
```

Opaque analyses (call counts, profiler counters) are policy evidence, not
semantic facts. They get their own typed surface so a reviewer can
immediately tell that profitability data is not being used as proof.
Profitability is always read at ROOT regardless of the view's bound
context — counters live at ROOT by architecture.

---

## 4. The TransformFactView surface, in full

```ts
interface TransformFactView {
  // value-only (ROOT fallback)
  read         <K, V>(a, key): V;
  tryRead      <K, V>(a, key): V | undefined;
  readAll      <K, V>(a):       ReadonlyMap<K, V>;
  readExprFact <L>   (a, nodeId): L | undefined;

  // witness-bearing
  readAt              <K, V>(a, key):     Reading<V>;
  readMinimal         <K, V>(a, key, accept): Reading<V> | undefined;
  readExprFactAt      <L>   (a, nodeId):       Reading<L> | undefined;
  readExprFactMinimal <L>   (a, nodeId, accept): Reading<L> | undefined;

  // policy
  readProfitability   <K, V>(a, key): V;

  // publication
  bodyAtRoot   (unit):                  StmtNS.Stmt[];
  bodyAtWitness(unit, reading: Reading<_>): StmtNS.Stmt[];
}
```

Semantic reads only accept may/must analyses — the type system rejects
opaque (profitability) analyses on the semantic surface. That keeps a
runtime counter from masquerading as a proof.

### Things you should not do

```ts
analysis.store.read(key, someContext)   // bypasses the view
readExprFact(topology, analysis, ...)   // framework-internal
speculativeTypeOf(...)                  // guarded-backend surface
transformFacts(topology, nonRootCtx)    // worklist binds this for you
```

The view is the entire safe surface. If you reach around it, you are
either writing framework code or writing a clone consumer (see
`speculative-clone.ts`); either way, that is a different role than
"transform author."

---

## 5. The minimal ROOT-only rule (the common case)

`unitSweepRule(...)` is a thin builder. It does not add semantics — it
just fills in `id`, `debugName`, and packages a `sweep` callback into a
`TransformRule`. Use it when your rule has no other state.

```ts
export const myRule = unitSweepRule(
  "myRule",
  (unit, facts) => {
    const visitor = new MyVisitor(facts);
    visitor.sweep(facts.bodyAtRoot(unit));
    return visitor.changed;
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

What each piece means:

1. `bodyAtRoot(unit)` — the rule mutates shared AST. The view is ROOT-bound
   (no `contextAware`), so `readExprFact` only returns ROOT-witnessed
   facts. Every rewrite is automatically ROOT-justified.
2. `return visitor.changed` — `true` iff `unit.funcAst.body` actually
   changed; that triggers a CFG rebuild.
3. The `edges` entry — a `FactEdge<Unit>`: when `someAnalysis.facts`
   advances on a block, the rule's dirty set gains that block's unit.

That last point is worth reading carefully:

> An `edge.wake(ctx, key)` is the **bridge** from the upstream analysis's
> key space (here, `BasicBlock`) into the transform's key space (`Unit`).
> Most authoring time is spent picking the right `wake`.

### About `unitSweepRule` itself

Right now it is a one-line wrapper around the `TransformRule` literal —
no semantics of its own. Two reasons we keep it anyway:

- it stamps a fresh `Symbol(name)` so two textually identical rules don't
  accidentally compare equal;
- it normalizes the `edges` default to `[]`.

If you want to set `contextAware: true` (or any other field), write the
literal directly — that is what `memoizationRule` does. Don't extend
`unitSweepRule` with knobs; the literal is the right tool past one knob.

---

## 6. The witness-scoped rule (the rare case)

Memoization is the model. The shape is:

```ts
export const memoizationRule: TransformRule = {
  id: Symbol("memoizationRule"),
  debugName: "memoizationRule",
  contextAware: true,
  edges: [/* fact edges to runtimeCallAnalysis, purityScopeAnalysis */],
  sweep(unit, facts) {
    const fd = unit.funcAst;
    if (!(fd instanceof StmtNS.FunctionDef)) return false;

    if (facts.readProfitability(runtimeCallAnalysis, fd.id) < THRESHOLD) return false;

    // Purity may hold under a speculative assumption. Find the weakest one.
    const witness = facts.readMinimal(purityScopeAnalysis, fd.id, v => v === true);
    if (witness === undefined) return false;

    // Publish at that witness — body is forked from the nearest owning
    // ancestor the first time we touch it.
    const body = facts.bodyAtWitness(unit, witness);

    // Idempotence guard: re-runs at descendant contexts inherit the
    // forked body via chain walk, and the prelude is already there.
    if (bodyHasMemoPrelude(body)) return false;

    const variant = guardKeyFromGuards(directParamEntryGuardsFor(unit, witness.witness));
    const rewritten = memoWrappedBody(fd, body, variant);
    body.length = 0;
    body.push(...rewritten);
    return true;
  },
};
```

What this teaches:

- `contextAware: true` so the view is bound at the unit's active spec
  context and `readMinimal` can reach non-ROOT witnesses.
- `readProfitability` — counters are policy, not proof. Read separately.
- `readMinimal(..., v => v === true)` — find the weakest assumption under
  which purity holds. The returned `Reading` carries the witness.
- `bodyAtWitness(unit, witness)` — publish there. ROOT witness is
  automatically the shared `unit.funcAst.body`.
- In-place mutation (`body.length = 0; body.push(...rewritten)`) preserves
  the array identity so descendant chain walks still resolve through this
  fork.
- Shape-idempotence (`bodyHasMemoPrelude`) means re-sweeping at a
  descendant context sees the prelude via the ancestor body and returns
  false.

If the rule were not `contextAware`, every read would resolve at ROOT and
`readMinimal` would never return a non-ROOT witness — memoization would
only fire for functions provably pure without any speculation, which
defeats the point.

---

## 7. Wiring: `edges`, `autoDirtyOn`, and the dispatch model

The worklist holds one **dirty set** per registered rule. Three things
add to it:

1. **Existing units at registration time.** `registerTransform` seeds the
   dirty set with every current unit, so a freshly registered rule fires
   at least once.
2. **Lifecycle events.** `autoDirtyOn` (default `["mint", "rebuild"]`)
   adds a unit when it is minted or after its CFG is rebuilt. A rule that
   only ever wants to be driven by fact changes can opt out with `[]`.
3. **Fact edges.** Each `edges` entry compiles into a fact subscription:
   when the upstream analysis writes, `wake(ctx, key)` is called and its
   yielded units are added.

After `processQueue` drains, the worklist sweeps each rule once over its
dirty units, then clears the set.

### Why `FactEdge<Unit>` and not a separate transform-edge type

`FactEdge` is shared with analyses (which use `FactEdge<K>` for various
`K`). A transform's natural key space is `Unit`, so it instantiates
`FactEdge<Unit>`. The `wake` projects from the upstream key space into
`Unit`s. Reusing the analysis edge shape means the dispatch path is
exactly one mechanism, not two — both end up calling the same
`subscribeFact` machinery.

The `LifecycleEdge` type also exists in the framework, but is reserved
for analyses that need to react to mint/rebuild/retire/specContextChange.
Transforms don't take `LifecycleEdge`s; the worklist synthesizes their
mint/rebuild reactions internally from `autoDirtyOn`.

So in transform-authoring terms:
- `edges: FactEdge<Unit>[]` — declarative subscriptions to upstream
  fact-cell writes.
- `autoDirtyOn` — declarative subscriptions to unit lifecycle.

That is the entire scheduling surface.

---

## 8. Choosing the right upstream edge

A transform should subscribe to the **smallest fact surface that actually
justifies the rewrite**.

For paired block DFA analyses (`X.env` / `X.facts`), that almost always
means subscribing to `.facts`:

- `.env` may advance without producing a new per-node fact your transform
  reads.
- `.facts` is what `readExprFact` reads.

`constant-folding`, `dead-branch`, and `algebraic-simplify` all subscribe
to the relevant `.facts` for this reason. `dead-store` subscribes to
`livenessAnalysis.env` because liveness publishes its per-block live-out
into `.env`.

> Subscribe to the analysis cell your transform actually reads.

---

## 9. Idempotency: rewrite must remove its own precondition

Transforms can run more than once: at registration, after every CFG
rebuild, after every relevant fact advance.

So a rewrite must be **shape-idempotent**: re-running on already-rewritten
code does nothing.

Patterns that work:

- constant folding replaces `Binary(...)` with `Literal(...)`; the
  `tag === "const"` check on a `Literal` cell never matches.
- dead-branch elimination splices the `If` out; the spliced-out arm has no
  `If` left to match.
- memoization checks `bodyHasMemoPrelude(body)` before rewriting; once
  the prelude is present at a witness, descendant sweeps see it via the
  body store walk.

Anti-pattern (don't do this):

```ts
fd.body.unshift(makeHelperStmt());
return true;
```

This stacks a duplicate prelude on every sweep. If the rewrite cannot
remove its own precondition, add an explicit guard predicate that does.

---

## 10. Returning `true` means "CFG rebuild required"

Return `true` iff the publication body actually changed structure.

Returning `true` schedules a CFG rebuild for `unit`, which re-runs the
analysis fixpoint over the new body. Returning `true` from a no-op sweep
sends the worklist into a needless rebuild cycle (and may not terminate
if combined with non-idempotent rewrite).

---

## 11. AST walking style

Most transforms use a local visitor class. That keeps:

- rewrite state (`changed`),
- fact access (`facts`),
- recursive traversal,
- helper predicates,

in one place and makes the rule self-contained.

Typical expression-rewrite skeleton:

```ts
class MyExprVisitor implements ExprNS.Visitor<ExprNS.Expr> {
  changed = false;
  constructor(private readonly facts: TransformFactView) {}

  rewrite(expr: ExprNS.Expr): ExprNS.Expr { return expr.accept(this); }

  visitBinaryExpr(expr: ExprNS.Binary): ExprNS.Expr {
    expr.left  = expr.left.accept(this);
    expr.right = expr.right.accept(this);
    const fact = this.facts.readExprFact(someAnalysis, expr.id);
    if (canRewrite(expr, fact)) {
      this.changed = true;
      return makeReplacement(expr, fact);
    }
    return expr;
  }
}
```

Lambda / nested-function bodies belong to **their own unit** and should
not be descended into from a parent unit's transform.

---

## 12. Special warning: transforms that add or remove functions

If your transform adds or removes a `FunctionDef`, `Lambda`, or
`MultiLambda`, you must coordinate with the function registry
(`framework/interfaces.ts`):

1. populate `functionEnvironments` for the new node, if adding;
2. call `registry.mint(newNode)` or `registry.retire(oldNode.id)`.

Function identity and slot layout are owned by the registry and consumed
by the worklist and compiler. Mutating function structure without
updating the registry creates a stale unit/slot mapping.

If your transform does not add/remove functions, you can ignore this
section.

---

## 13. Safety checklist

### Fact-safety
- [ ] Every fact read goes through `facts`. No `analysis.store.read(...)` calls.
- [ ] Profitability data is read via `readProfitability`, not `read`.
- [ ] No speculative-query API (`speculativeTypeOf`, `speculativeConstOf`, …).
- [ ] No call to `transformFacts(topology, ...)` in transform code.

### Publication
- [ ] If the rule mutates shared AST (expression nodes, nested arrays):
      `contextAware` is unset; mutate via `bodyAtRoot(unit)`.
- [ ] If the rule mutates only the top-level body and uses `readMinimal`
      witnesses: `contextAware: true`; mutate via `bodyAtWitness(unit, w)`.
- [ ] In-place `body.length = 0; body.push(...new)` — preserve array identity
      so descendant chain walks resolve through the fork.

### Scheduling
- [ ] `edges` mention the upstream analyses whose advances actually matter.
- [ ] `wake(ctx, key)` projects upstream keys into `Unit`s correctly.
- [ ] Subscribed to the narrowest useful fact surface (usually `.facts`,
      not `.env`).

### Rebuild / idempotency
- [ ] `sweep` returns `true` iff the published body actually changed.
- [ ] Re-running on rewritten code returns `false` — either by shape
      idempotence or an explicit guard predicate.

### Structure
- [ ] Nested functions handled deliberately (typically: do not descend).
- [ ] If function structure changes, the registry contract is honored.

---

## 14. Common mistakes

### Mistake 1: using a speculative read as proof
```ts
const spec = dfaQuery.speculativeConstOf(expr.id);
if (spec?.tag === "const") fold(...);
```
The AST mutation is permanent; the speculative fact is not. Read through
the view. If you really need a non-ROOT fact, set `contextAware: true`,
use `readMinimal`, and publish at the witness.

### Mistake 2: subscribing to the wrong cell
`edges: [{ on: "fact", analysis: typeAnalysis.env, ... }]` will fire on
`.env` advances that produce no `.facts` change. Subscribe to the cell
your `read*` calls actually consume.

### Mistake 3: replacing the body array
```ts
unit.funcAst.body = newBody;  // wrong
```
breaks chain-walk lookups in the body store. Mutate the array in place.

### Mistake 4: re-runnable rewrites that don't self-terminate
Idempotence by accident is a bug waiting to happen. Either the rewrite
removes its match shape, or there is an explicit guard. Pick one and be
intentional.

### Mistake 5: descending into nested functions
A nested `FunctionDef` owns its own unit and is swept independently. A
parent-unit transform that recurses into the child duplicates work and
risks rewriting subtree nodes the child unit also owns.

---

## 15. Where to look for examples

ROOT-only transforms (the common shape):
- `src/specialization/transforms/constant-folding.ts`
- `src/specialization/transforms/dead-branch.ts`
- `src/specialization/transforms/algebraic-simplify.ts`
- `src/specialization/transforms/dead-store.ts`

Witness-scoped transform (the rare shape):
- `src/specialization/transforms/memoization.ts`

Framework contracts to read alongside this guide:
- `src/specialization/framework/analysis.ts` — `TransformRule`,
  `TransformFactView`, `Reading`, `FactEdge`, `LifecycleEdge`
- `src/specialization/framework/transform-rule.ts` — the view constructor
  and `unitSweepRule` builder
- `src/specialization/framework/chain-body-store.ts` — `bodyFor` /
  `forkBodyAt` (the publication mechanism)
- `src/specialization/framework/worklist.ts` — `registerTransform`,
  `sweepTransforms`

---

## 16. Short recipe

1. Decide whether you really need a transform vs. an analysis.
2. Decide whether your rewrite is ROOT-only or witness-scoped.
   - Touches shared AST nodes → ROOT-only. `contextAware` unset.
     Mutate via `bodyAtRoot(unit)`.
   - Touches only the top-level body and wants to capture speculative
     witnesses → context-aware. `contextAware: true`. Use `readMinimal`
     and `bodyAtWitness`.
3. Use `unitSweepRule(...)` for the ROOT-only case; write the literal
   directly when you need other knobs.
4. Read facts only through the `TransformFactView`. Use
   `readProfitability` for opaque counters.
5. Wire `edges` to the narrowest upstream cell that actually drives the
   rewrite, projecting keys to `Unit`s in `wake`.
6. Make the rewrite shape-idempotent.
7. Return `true` iff the published body changed.
8. If function structure changes, update the registry.

That is the transform-author contract in this codebase.
