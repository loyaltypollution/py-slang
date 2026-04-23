# 04 — Cross-parse chain identity: a category error, not a gap

## What the interner actually promises

`ContextInterner` (assumption-chain-interner.ts) canonicalizes at the level of
`(parent AssumptionChain, Narrowing reference, key value, narrowing.eq(value))`.
Its two invariants are:

1. **Structural equality ⇒ reference equality** — within one process, the same
   `(parent, narrowing, key, value)` tuple returns the same node.
2. **Arrival-order independence** — links are sorted by a per-interner
   narrowing ordinal (`narrowingOrdinals`, lazily minted on first sight) and
   then by `compareKey(key)`. Reordered observations reconverge.

The ordinal WeakMap is **per-process, not stable across processes**. The
module header says this out loud: "canonical order is deterministic within a
process even though it is not stable across processes — chains are not
serialized." So the identity claim is "same process, same `defaultInterner`,"
not "same program text."

## Is `fn.id` parse-local or process-global?

`src/ast-types.ts:8` — `let _nextNodeId = 1;` with `this.id = _nextNodeId++`
in `Expr` and `Stmt` constructors. It is a **process-global monotonic
counter**. Every parse mints fresh IDs; two parses of the same source produce
disjoint ID ranges. Therefore `paramKey(fd.id, i)` differs between parses by
construction — the `key` dimension of the interner trie is disjoint, so the
`ValueBucket` lookup cannot collide even in principle.

This is not a bug in the interner or the key design. Two independent parses
are two independent programs as far as the runtime is concerned; there is no
shared-text-implies-shared-optimization contract.

## Does the second test assert something meaningful?

No. The `describe` string ("two worklists, two observation orders, one
canonical chain") promises something the key space forbids. The test body
acknowledges this at lines 116–121 ("the keys differ and the chains won't
literally ==="), then silently pivots to a **different** assertion:

> rebuild chainA's links from ROOT in child-first (reverse-canonical) arrival
> order, and verify the rebuild === chainA.

That is a pure intra-parse assertion about order-independence of
`extendContext`. It exercises exactly the invariant the **first** test
already relies on (`reborn === hotChain` after widen-then-reobserve stacks
assumptions in potentially-different orders), and it uses the same
`defaultInterner`. Worklists B and C do nothing in the final assertion — B is
kept alive only so "the second worklist did speculate" doesn't vacuously
pass, and C is never read (`void unitC`).

Status labels:
- **established**: `fn.id` is process-global monotonic; `paramKey` carries
  that ID verbatim; chainA and chainB cannot share identity by construction.
- **established**: the interner's contract is per-process, not cross-parse.
- **plausible**: no production consumer wants cross-parse chain identity.
  Grep over `src/specialization` and `src/conductor` shows chain-keyed maps
  (`AnalysisStore.cellsByContext`, `speculative-clone` forks, entry-guard
  projection) all live inside a single worklist/topology; none survive a
  reparse.

## OBJECTION

The second test's `describe` string is a false promise. What it actually
verifies — order-independent intra-interner canonicalization — is already
covered by the first test's `reborn === hotChain` assertion, which is a
harder case (widen-then-reobserve across a `defaultInterner.exclude` +
`extend` cycle).

**CRUX**: cross-parse chain identity is not a framework invariant and no
production path wants it. The "gap" the test gestures at does not exist.

## Recommended fix

Delete the second test, or reduce it to a single-parse, single-worklist
order-independence check with an honest name. A minimal replacement:

```
test("canonical order is independent of extend arrival order", () => {
  // two extendContext sequences on the same (narrowing, key, value) triples
  // in opposite orders must ===.
});
```

No `setupAndDrain`, no worklists, no `paramKey` — just the interner. The
current form is a contortion around a non-problem, and the describe string
misleads readers into believing the framework makes a cross-parse promise it
explicitly disclaims.

**Do not** add a `chain.structuralKey()` API. It would serve no consumer and
would re-open the cross-process determinism question the interner comment
deliberately closes.
