// Canonicalizing interner for AssumptionChain chains.
//
// `extendContext` used to allocate a fresh `Object.freeze({...})` per call; two
// observations producing the same assumption chain produced two distinct AssumptionChain
// objects, fragmenting every AssumptionChain-keyed data structure downstream
// (analysis-store cells, JIT IR cache, worklist pending-set). This interner
// canonicalizes:
//
//   1. Structural equality ⇒ reference equality. Repeating an observation
//      returns the same AssumptionChain object — downstream Map<AssumptionChain,_> structures
//      de-fragment automatically.
//
//   2. Assumption-set identity ⇒ chain identity, regardless of arrival order.
//      Chains are built in canonical order `(narrowing.debugName, String(key))`
//      so the same set of assumptions always yields the same chain. A
//      lineage-precise widen that prunes a middle link lands on a chain that
//      any prior compilation under the surviving assumption subset would have
//      produced — enabling sibling IR cache hits.
//
// Trie shape: `parent -> narrowing -> key -> ValueBucket`. A ValueBucket is a
// small array scanned linearly via `narrowing.eq`. Per-bucket cardinality is
// bounded by the distinct observed values at one (narrowing, nodeId) site
// (typically 1–3). `narrowing.eq` is the canonical structural equality for
// assumption values; using ref-equality here would fork the trie where it
// should have converged — `const(v)` from separate `liftConst` calls is
// structurally equal but reference-different.

import { type AssumptionHandle } from "./analysis";
import type { Assumption, AssumptionChain } from "./context";
import { CHAIN_PROTO, ROOT_CONTEXT } from "./context";

/** Total order on (narrowing.debugName, key). `debugName` is globally unique
 *  across registered narrowings; keys are node ids (numbers) for narrowings.
 *  Any deterministic order suffices for canonicalization. */
function compareAssumption(a: Assumption, b: Assumption): number {
  const na = a.narrowing.debugName;
  const nb = b.narrowing.debugName;
  if (na < nb) return -1;
  if (na > nb) return 1;
  return compareKey(a.key, b.key);
}

function compareKey(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

interface ValueEntry {
  readonly value: unknown;
  readonly node: AssumptionChain;
}

export class ContextInterner {
  private readonly children: Map<
    AssumptionChain,
    Map<AssumptionHandle<any, any>, Map<unknown, ValueEntry[]>>
  > = new Map();

  /** Extend `parent` with `(narrowing, key, value)`, returning a canonical
   *  AssumptionChain. Equal values are dedup'd via the narrowing's
   *  value-equality relation; the caller does not supply an equality
   *  predicate. */
  extend<K, V>(
    parent: AssumptionChain,
    narrowing: AssumptionHandle<K, V>,
    key: K,
    value: V,
  ): AssumptionChain {
    const parentAssumption = parent.assumption;
    if (parentAssumption === undefined) {
      return this.internChild(parent, narrowing, key, value);
    }
    const newLink: Assumption = {
      narrowing: narrowing as AssumptionHandle<unknown, unknown>,
      key: key as unknown,
      value: value as unknown,
    };
    const cmp = compareAssumption(newLink, parentAssumption);
    if (cmp > 0) {
      return this.internChild(parent, narrowing, key, value);
    }
    // cmp === 0 (same (narrowing, key) — replace) or cmp < 0 (sorts earlier —
    // must rebuild). Either path goes through rebuildWith.
    return this.rebuildWith(parent, narrowing, key, value);
  }

  /** Remove every link at `(narrowing, key)` from `ctx`. Identity-returns
   *  `ctx` when no link matches — callers can short-circuit on reference
   *  equality. The canonical invariant guarantees at most one match
   *  (collisions at the same `(narrowing, key)` are replaced at
   *  extend-time, not layered). */
  exclude<K>(ctx: AssumptionChain, narrowing: AssumptionHandle<K, any>, key: K): AssumptionChain {
    const narrowingAsKey = narrowing as unknown as AssumptionHandle<unknown, unknown>;
    const links: Assumption[] = [];
    let found = false;
    for (let cur: AssumptionChain | undefined = ctx; cur !== undefined; cur = cur.parent) {
      const a = cur.assumption;
      if (a === undefined) continue;
      if (a.narrowing === narrowingAsKey && a.key === key) {
        found = true;
        continue;
      }
      links.push(a);
    }
    if (!found) return ctx;
    // Links are collected child-first. Build the interned chain from root to
    // child by walking backward — avoids Array.reverse() + internList allocation.
    let result: AssumptionChain = ROOT_CONTEXT;
    for (let i = links.length - 1; i >= 0; i--) {
      const a = links[i];
      result = this.internChild(result, a.narrowing, a.key as never, a.value as never);
    }
    return result;
  }

  /** Diagnostic: number of non-root interned nodes. Not part of the public
   *  contract — used by tests and for memory accounting. */
  debugNodeCount(): number {
    let count = 0;
    for (const byNarrowing of this.children.values()) {
      for (const byKey of byNarrowing.values()) {
        for (const bucket of byKey.values()) {
          count += bucket.length;
        }
      }
    }
    return count;
  }

  private internChild<K, V>(
    parent: AssumptionChain,
    narrowing: AssumptionHandle<K, V>,
    key: K,
    value: V,
  ): AssumptionChain {
    const narrowingAsKey = narrowing as unknown as AssumptionHandle<any, any>;
    let byNarrowing = this.children.get(parent);
    if (byNarrowing === undefined) {
      byNarrowing = new Map();
      this.children.set(parent, byNarrowing);
    }
    let byKey = byNarrowing.get(narrowingAsKey);
    if (byKey === undefined) {
      byKey = new Map();
      byNarrowing.set(narrowingAsKey, byKey);
    }
    let bucket = byKey.get(key);
    if (bucket === undefined) {
      bucket = [];
      byKey.set(key, bucket);
    }
    for (const entry of bucket) {
      if (narrowing.eq(entry.value as V, value)) return entry.node;
    }
    const node: AssumptionChain = Object.freeze(
      Object.assign(Object.create(CHAIN_PROTO), {
        parent,
        assumption: Object.freeze({
          narrowing: narrowing as AssumptionHandle<unknown, unknown>,
          key: key as unknown,
          value: value as unknown,
        }),
        depth: parent.depth + 1,
      }) as AssumptionChain,
    );
    bucket.push({ value, node });
    return node;
  }

  /** Flatten parent chain, dedup at `(narrowing, key)` keeping the new
   *  value, sort canonically, and intern. Used when the new assumption
   *  sorts before an existing one or collides at the same `(narrowing,
   *  key)`. */
  private rebuildWith<K, V>(
    parent: AssumptionChain,
    narrowing: AssumptionHandle<K, V>,
    key: K,
    value: V,
  ): AssumptionChain {
    const links: Assumption[] = [];
    const narrowingAsKey = narrowing as unknown as AssumptionHandle<unknown, unknown>;
    for (let cur: AssumptionChain | undefined = parent; cur !== undefined; cur = cur.parent) {
      const a = cur.assumption;
      if (a === undefined) continue;
      if (a.narrowing === narrowingAsKey && a.key === key) continue;
      links.push(a);
    }
    links.push({
      narrowing: narrowingAsKey,
      key: key as unknown,
      value: value as unknown,
    });
    links.sort(compareAssumption);
    return this.internList(links);
  }

  private internList(sorted: ReadonlyArray<Assumption>): AssumptionChain {
    let cur: AssumptionChain = ROOT_CONTEXT;
    for (const a of sorted) {
      cur = this.internChild(cur, a.narrowing, a.key, a.value);
    }
    return cur;
  }
}

/** Module-scoped singleton backing the free-function `extendContext` /
 *  `excludeAssumption` in `context.ts`. Single process-wide interner keeps the
 *  free-function API stable and avoids threading an instance through every
 *  caller. Memory is bounded by the set of distinct canonical chains the
 *  process observes — in practice throttled by the speculation strategy. */
export const defaultInterner = new ContextInterner();
