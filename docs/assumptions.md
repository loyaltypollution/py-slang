# Framework Assumptions

Load-bearing invariants asserted in code. Each entry is the exact source
comment, paired with its file:line anchor. When an invariant moves or is
relaxed, update it here and at the anchor in the same commit.

## Purity of DFA block transfer

**`src/specialization/framework/dfa-factory.ts`** — `transferBlock` MUST
be pure: no `factStore.write`, no mutation of `unit`. Side-effect writes
from inside this function bypass the lattice-equals gate and reopen the
spurious-wake bug class the framework exists to prevent.

## Idempotence under lattice.equals

**`src/specialization/framework/pass.ts`** — Side effects in `transfer`
(e.g. JIT `patchFunction`) must be idempotent under `lattice.equals`: if
the produced value equals the current one, the side effect must be a
no-op, so spurious re-transfers on already-converged facts do not cause
observable behavior changes.

## prune's keyspace

**`src/specialization/framework/pass.ts`** — `previousKeys` is the full
keyset this pass has written across *all* units, not just the rebuilt
one. The implementation must filter to keys belonging to `unit`
(typically `k.unit === unit` for block keys, `k === unit` for unit keys,
or `ctx.unitForNode(k) === unit` for node keys). Returning a key from
another unit would incorrectly evict it.

## Memoization is one-shot

**`src/specialization/transforms/memoization.ts`** — Intentionally no
`prune`: memoization is one-shot per function. Once wrapped,
`applyMemoizationWrap` returns false on re-entry, so the "fired" cell
persists forever after first fire and the equality gate suppresses
spurious onChange events. Pruning would force an infinite loop because
the sweep is self-triggering (structural rebuild wakes this rule, which
would rewrite "fired", bumping structural again).

## Memoization shape-detection guard

**`src/specialization/transforms/memoization.ts`** — Transfer mutates
AST eagerly; the lattice "fired" write gates dispatch fan-out but the
side effect happens before any equality check. Detect the prelude by
shape: an `If` whose condition is a Call to `MEMO_HAS`.

## pendingRebuilds ordering

**`src/specialization/framework/worklist.ts`** — Units with a
transform-tier "fired" write that have not yet had their CFG rebuilt.
Populated by `handleFactChange`; drained after `drainPasses` finishes so
pruning doesn't clear fired markers mid-drain.

## Fact-store evict is silent

**`src/specialization/framework/fact-store.ts`** — `evict` does not
emit events.

## DFA self-read forward-reference

**`src/specialization/framework/dfa-factory.ts`** — Forward-reference
pattern: `reads` must include the pass itself so block-OUT changes wake
CFG-successors through the dispatch graph. The array is built first,
populated with the self-reference after the pass object exists, then
frozen. ReadonlyArray contract preserved.

## Call-count saturation suppresses onChange

**`src/specialization/memoization-analysis/call-count.ts`** — The
lattice join is `max` but saturates at `CALL_COUNT_SAT`, so equal writes
beyond threshold suppress `onChange` and stop dispatch fan-out.

## Equality-gated writes collapse dirty tracking

**`src/specialization/framework/fact-store.ts`** — Equality-identical
writes produce no event. This single primitive replaces the
`markDirty`/`flushDirty`/`subscribers` triad; saturating lattices (e.g.
`callCountPass`) rely on it to suppress downstream work once converged.
