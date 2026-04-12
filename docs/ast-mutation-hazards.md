# AST Mutation Hazards Under Concurrent DFA

The optimization vision (see `optimization-roadmap.md`) moves DFA from a
batch pre-pass to a background process that accumulates results while consumers
are running. This creates a fundamental tension: **the AST is a shared mutable
structure, and today's DFA mutates it in-place.**

This document catalogs the failure modes, classifies them, and frames the
architectural decision: **AST mutations by DFA must be transparent to consumers
that haven't opted in.**

---

## How DFA Mutates the AST Today

Five mutation sites, all in `stabilizeStatic` / `applyTransformPass`:

| Mutation | What happens | Example |
|----------|-------------|---------|
| **Expr replacement** | `parent[field] = newLiteral` — child pointer overwritten | Constant folding replaces `Binary(3+4)` with `Literal(7)` |
| **Array element replacement** | `arr[i] = newExpr` — expression array element overwritten | Folding inside `Call.args` |
| **Statement splice** | `stmts.splice(i, 1, ...body)` — array structurally mutated | Dead branch elimination replaces `If` with its taken branch |
| **Hint stamping** | `node.hint = hint` — property added to existing node object | `annotateTree()` after analysis |
| **Node orphaning** | Old node becomes unreachable from tree but still exists in memory | Replaced `Binary` node still has WeakMap hint entry |

Key: **no defensive copies anywhere.** The caller's `stmts` array IS the array
being spliced. Nodes are plain mutable class instances.

---

## Consumer Reference Patterns

Each consumer holds AST references differently. This determines what breaks.

### CSE Machine (tree-walker) — HIGH RISK

The CSE machine holds **persistent, re-entrant** references:

- **`Closure.node`** — permanent. Every closure stores a reference to its
  `FunctionDef` or `Lambda` node. `node.body` is read on every call. If
  `FunctionDef.body` is splice-mutated, all live closures immediately see the
  change. If the `FunctionDef` node itself is replaced, closures hold a dangling
  reference to the old (now orphaned) node.

- **`WhileInstr.test` / `WhileInstr.body`** — re-entrant. Extracted from the
  `While` node at creation time and re-pushed on every iteration. If
  `test.left` is overwritten by constant folding between iterations, the next
  iteration evaluates a different expression.

- **`BoolOpInstr.srcNode`** — deferred read. The handler reads
  `srcNode.right` at execution time, not at creation time. If the `BoolOp`
  node's `.right` field is overwritten between creation and execution, the
  wrong operand is evaluated.

- **`srcNode` on every instruction** — used for error reporting. Low-severity
  if mutated (wrong source location in error messages), but pervasive.

### Resolver -> Compiler Handoff — MEDIUM RISK

`functionEnvironments: Map<FunctionDef | Lambda, Environment>` is keyed on
**node identity**. If a transform replaces a `FunctionDef` node (doesn't happen
today, but dead branch elimination could evolve to do this), the compiler's
`functionEnvironments.get(newNode)` returns `undefined` and throws.

Current transforms don't replace function-scope nodes, so this is **latent**
but becomes live the moment a transform touches function boundaries (e.g.,
function inlining, dead function elimination).

### SVML Compiler — LOW RISK (one-shot)

Reads `node.hint` eagerly during a synchronous traversal. If `.hint` is absent
(new node from folding, not yet re-annotated), it falls back to generic opcodes.
Not a crash, just a missed optimization.

### WASM Compiler — NO RISK

Holds no persistent AST node references. Reads string names only.

---

## Failure Mode Classification

### Class 1: Structural Shift (array mutations under iteration)

**Trigger:** `stmts.splice()` while a consumer iterates the same array.

**Symptom:** Consumer skips statements or visits the same statement twice.
No crash — silent wrong behavior.

**Affected:** CSE machine (StatementSequence.body is the same array object
that transforms splice), any future tree-walker.

**Severity:** Critical. The consumer executes a different program than intended
with no indication of error.

### Class 2: Identity Orphaning (node replacement breaks keyed lookups)

**Trigger:** `parent[field] = newNode` replaces a node that is a key in
`functionEnvironments`, `HintTable`, or `tokenAnnotations`.

**Symptom:** Map/WeakMap lookup returns `undefined` for the new node. Old node
entry becomes a memory leak (Map) or silently GC'd (WeakMap).

**Affected:** Resolver -> compiler handoff (functionEnvironments), hint
consumption (HintTable), slot annotation (tokenAnnotations).

**Severity:** High for functionEnvironments (throws). Low for WeakMaps (missed
optimization, no crash).

### Class 3: Dangling Reference (consumer holds ref to orphaned node)

**Trigger:** DFA replaces or splices out a node that a consumer has stored.

**Symptom:** Consumer reads stale data from the orphaned node. Behavior diverges
from the live AST silently.

**Affected:** `Closure.node` (permanent), `WhileInstr.test` / `.body`
(re-entrant), `BoolOpInstr.srcNode` (deferred read).

**Severity:** Critical for Closure.node and WhileInstr — semantic divergence.
The consumer runs a program that no longer exists in the AST.

### Class 4: Mid-Expression Mutation (child field overwritten between creation and use)

**Trigger:** DFA overwrites `expr.right` between the time a `BoolOpInstr` is
created (from `expr.left`) and the time the handler reads `srcNode.right`.

**Symptom:** Short-circuit evaluation uses the wrong operand.

**Affected:** Any instruction type that defers reading back into its source node.

**Severity:** High. Produces wrong results silently.

### Class 5: Annotation Flicker (hints appear, disappear, or change)

**Trigger:** `annotateTree()` runs while a consumer is reading `.hint`.
Or: a node is replaced, losing its hint, then re-annotated on the next pass.

**Symptom:** Consumer sees inconsistent hints across nodes in the same
expression (e.g., `left.hint` is from pass N, `right.hint` from pass N-1).

**Affected:** SVML compiler (reads `.hint` for opcode selection), any future
hint consumer.

**Severity:** Low in isolation (conservative fallback to generic opcodes). But
inconsistent hints across an expression could theoretically produce unsound
specialization if a consumer trusts that hints are globally coherent.

---

## The Architectural Principle

**DFA's AST mutations must be opt-in for consumers.**

In the AOT model, this was trivially satisfied: DFA runs first, consumers run
second. No overlap, no conflict.

In the concurrent model, we need a mechanism that gives each consumer a
**stable view** of the AST by default, and lets consumers **explicitly opt in**
to seeing DFA mutations — at a granularity and pace they control.

This is the core design question. Candidate approaches:

### Approach 1: Snapshot Isolation (copy-on-write AST)

DFA works on a mutable draft. When it reaches a stable point, it publishes a
new immutable snapshot. Consumers read from their snapshot until they
explicitly request the next one.

- **Pro:** Clean separation. Consumers never see partial mutations.
- **Con:** Copying the AST is expensive. Structural sharing (persistent data
  structures) would mitigate but is a large infrastructure investment.
- **Tension:** The CSE machine's `Closure.node` points into the old snapshot.
  When the consumer upgrades to a new snapshot, all closures must be re-pointed.

### Approach 2: Epoch Fencing

DFA mutations happen in discrete "epochs." Each mutation is tagged with an
epoch number. Consumers declare which epoch they're reading from. A consumer
at epoch N sees the AST as it was at epoch N, even if DFA has advanced to
epoch N+3.

- **Pro:** No copying — consumers just ignore mutations from later epochs.
- **Con:** Requires every mutation to be tagged and every read to be
  epoch-aware. Retrofitting this onto plain property reads is invasive.
- **Open question:** How does a consumer "upgrade" its epoch? Does it need
  to pause execution, reconcile its state, and resume?

### Approach 3: Mutation Log + Replay

DFA appends mutations to a log instead of applying them directly. Consumers
replay mutations from the log when they're ready. The AST itself remains
stable until a consumer applies pending mutations.

- **Pro:** Consumers control when mutations land. The log is the diff.
- **Con:** Two sources of truth (AST state vs. log). Consumers must
  understand how to replay structural mutations (splices, node replacements).
- **Synergy:** This overlaps with Option D (Event Log) in the roadmap. The
  mutation log and the annotation-change log could be the same structure.

### Approach 4: Dual-AST (Frozen + Live)

Maintain two AST copies: the "frozen" AST that consumers read, and the "live"
AST that DFA mutates. Periodically swap: the live AST becomes the new frozen,
DFA gets a fresh copy to mutate.

- **Pro:** Simple mental model. Consumers always read a stable tree.
- **Con:** Doubling memory. Swap points require all consumers to release
  references to the old frozen AST — same Closure.node re-pointing problem.

### Approach 5: Transform Deferral (separate annotations from mutations)

Split DFA's output into two categories:
1. **Annotations** (hint stamping) — always safe. Monotonically refined.
   Consumers can read at any time; stale annotations are conservative, not wrong.
2. **Structural transforms** (splices, replacements) — deferred. DFA records
   "I want to eliminate this dead branch" as an intent. Consumers opt in to
   applying the intent when they're ready.

- **Pro:** Annotations flow freely (the common case). Only structural transforms
  need coordination — and these are rarer.
- **Con:** Deferred transforms mean the AST doesn't shrink until a consumer
  applies them. Analysis continues on the un-transformed AST, potentially
  missing optimizations that depend on earlier transforms.
- **Synergy:** Matches the existing `annotateTree()` vs. `applyTransformPass()`
  split. The annotation path is already safe-ish (property addition, not
  structural change). The transform path is where all Class 1-4 hazards live.

---

## Class 6: Non-Monotone Transform in Unified Worklist

**Context:** The target architecture unifies analysis propagation and AST
transforms into a single persistent worklist. Analysis facts, runtime
observations, and transforms are all work items processed by the same loop.
This means transforms can fire mid-analysis — not in a separate phase.

**The monotonicity requirement:** The DFA worklist converges because lattice
operations are monotone (values only get more precise, never less). If
transforms are also worklist items, they must satisfy the same property:
a transform can only make the lattice state more precise, never less.

**Transforms that are monotone:**
- Dead branch elimination — removes unreachable code, reducing the state space.
  All surviving blocks' lattice values remain valid or become more precise.
- Constant folding — replaces `Binary(3+4)` with `Literal(7)`. The folded
  node's hint is at least as precise as the original's.

**Transforms that may not be monotone:**
- Memoization wrapping — adds new AST nodes (cache lookup, cache store) that
  have no analysis facts yet. The lattice for these nodes starts at ⊥ (bottom),
  which is *less* precise than the original code's fully-analyzed state. The
  worklist must re-analyze the wrapper to reach a new fixpoint.
- Function inlining (hypothetical) — replaces a call with the function body.
  New nodes enter at ⊥. Same issue.

**Why this matters:** In the two-phase model (analyze → transform → re-analyze),
non-monotone transforms are fine because analysis restarts from scratch on the
new AST. In the unified worklist, a non-monotone transform creates a temporary
"dip" in precision. The worklist will eventually recover (re-analysis of the
new nodes propagates upward), but intermediate states are inconsistent: some
blocks have facts computed against the old AST, others against the new.

**Risk assessment:**
- If consumers only read hints at quiescent points (worklist idle), this is
  safe — by the time they read, the worklist has re-converged.
- If consumers read hints mid-convergence (e.g., a tree-walker checking hints
  per-step while analysis is running), they may see stale facts on new nodes.
  This is Class 5 (annotation flicker) applied to structurally new nodes.

**Mitigation options:**
1. **Epoch the transform:** Mark non-monotone transforms as "epoch boundaries."
   The worklist finishes all pending analysis work, applies the transform, then
   re-seeds affected blocks. Consumers see a clean transition.
2. **Two-tier worklist:** Analysis items are high-priority; transform items are
   low-priority and only fire when the analysis queue is empty (local fixpoint
   reached). This preserves monotonicity within each analysis phase while still
   using a single scheduling primitive.
3. **Accept the inconsistency.** If consumers only read at idle points and the
   lattice guarantees eventual convergence, the intermediate inconsistency is
   unobservable. Document this as a design invariant.

**Status:** Shelved. The unified worklist is the target architecture but the
monotonicity argument for specific transforms (especially memoization) needs
to be worked through when those transforms are implemented.

---

## Recommended Investigation Order

1. **Measure whether structural transforms matter at all.** If constant folding
   and dead branch elimination rarely fire (or fire only once in the first pass),
   deferral may be sufficient and the concurrent mutation problem is mostly about
   annotations — which are already monotonic and conservative.

2. **Prototype Approach 5 (annotation/transform split).** This requires the least
   infrastructure change. Annotations keep flowing. Transforms become intents
   in a log. Consumers apply intents at their chosen pace.

3. **If Approach 5 is insufficient,** prototype Approach 1 (snapshot isolation)
   for the structural AST. This handles all five failure classes but requires
   persistent data structures or periodic deep-copy.

---

## Failure Mode / Approach Coverage Matrix

| Failure Class | Approach 1 (Snapshot) | Approach 2 (Epoch) | Approach 3 (Log) | Approach 4 (Dual) | Approach 5 (Defer) |
|---|---|---|---|---|---|
| 1. Structural shift | Solved | Solved | Solved (if replay is atomic) | Solved | Solved (transforms are deferred) |
| 2. Identity orphaning | Solved (new snapshot = new identity space) | Partial (epoch-aware lookups) | Partial (log must track identity mapping) | Solved | Solved for transforms; N/A for annotations |
| 3. Dangling reference | Requires re-pointing on snapshot upgrade | Requires epoch-aware refs | Requires ref update on replay | Requires re-pointing on swap | Deferred transforms never orphan |
| 4. Mid-expression mutation | Solved | Solved | Solved | Solved | Solved (no concurrent expr mutation) |
| 5. Annotation flicker | Solved | Solved | N/A (annotations not in log) | Solved | Partially solved (annotations still mutate in-place; but monotonic, so flicker is conservative) |
