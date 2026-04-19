// Canonicalizing interner for Context chains.
//
// `extendContext` used to allocate a fresh `Object.freeze({...})` per call; two
// observations producing the same assumption chain produced two distinct Context
// objects, fragmenting every Context-keyed data structure downstream
// (fact-store cells, JIT IR cache, worklist pending-set). This interner
// canonicalizes:
//
//   1. Structural equality ⇒ reference equality. Repeating an observation
//      returns the same Context object — downstream Map<Context,_> structures
//      de-fragment automatically.
//
//   2. Assumption-set identity ⇒ chain identity, regardless of arrival order.
//      Chains are built in canonical order `(analysis.debugName, String(key))`
//      so the same set of assumptions always yields the same chain. A
//      lineage-precise widen that prunes a middle link lands on a chain that
//      any prior compilation under the surviving assumption subset would have
//      produced — enabling sibling IR cache hits.
//
// Trie shape: `parent -> handle -> key -> ValueBucket`. A ValueBucket is a
// small array scanned linearly via `handle.lattice.eq`. Per-bucket
// cardinality is bounded by the distinct observed values at one (handle,
// nodeId) site (typically 1–3). `handle.lattice.eq` is the canonical
// structural equality (see `Lattice<V>` in `./analysis`); using ref-equality
// here would fork the trie where it should have converged — `const(v)` from
// separate `liftConst` calls is structurally equal but reference-different.

import type { Analysis } from "./analysis";
import type { Assumption, Context } from "./context";
import { ROOT_CONTEXT } from "./context";

/** Total order on (analysis.debugName, key). `debugName` is globally unique
 *  across registered analyses; keys are node ids (numbers) for narrowings.
 *  Any deterministic order suffices for canonicalization. */
function compareAssumption(a: Assumption, b: Assumption): number {
  const na = a.analysis.debugName;
  const nb = b.analysis.debugName;
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
  readonly node: Context;
}

export class ContextInterner {
  private readonly children: Map<
    Context,
    Map<Analysis<any, any>, Map<unknown, ValueEntry[]>>
  > = new Map();

  /** Extend `parent` with `(handle, key, value)`, returning a canonical
   *  Context. Equal values are dedup'd via `handle.lattice.eq`; the caller
   *  does not supply an equality predicate. */
  extend<K, V>(
    parent: Context,
    handle: Analysis<K, V>,
    key: K,
    value: V,
  ): Context {
    const parentAssumption = parent.assumption;
    if (parentAssumption === undefined) {
      return this.internChild(parent, handle, key, value);
    }
    const newLink: Assumption = {
      analysis: handle as Analysis<unknown, unknown>,
      key: key as unknown,
      value: value as unknown,
    };
    const cmp = compareAssumption(newLink, parentAssumption);
    if (cmp > 0) {
      return this.internChild(parent, handle, key, value);
    }
    // cmp === 0 (same (handle, key) — replace) or cmp < 0 (sorts earlier —
    // must rebuild). Either path goes through rebuildWith.
    return this.rebuildWith(parent, handle, key, value);
  }

  /** Remove every link at `(handle, key)` from `ctx`. Identity-returns `ctx`
   *  when no link matches — callers can short-circuit on reference equality.
   *  The canonical invariant guarantees at most one match (collisions at the
   *  same `(handle, key)` are replaced at extend-time, not layered). */
  exclude<K>(ctx: Context, handle: Analysis<K, any>, key: K): Context {
    const links: Assumption[] = [];
    let found = false;
    for (let cur: Context | undefined = ctx; cur !== undefined; cur = cur.parent) {
      const a = cur.assumption;
      if (a === undefined) continue;
      if (a.analysis === (handle as unknown as Analysis<unknown, unknown>) && a.key === key) {
        found = true;
        continue;
      }
      links.push(a);
    }
    if (!found) return ctx;
    // Collected child-first; reverse to root-first. Input chain is canonical,
    // so reversed list is already sorted — no re-sort needed.
    links.reverse();
    return this.internList(links);
  }

  /** Diagnostic: number of non-root interned nodes. Not part of the public
   *  contract — used by tests and for memory accounting. */
  debugNodeCount(): number {
    let count = 0;
    for (const byHandle of this.children.values()) {
      for (const byKey of byHandle.values()) {
        for (const bucket of byKey.values()) {
          count += bucket.length;
        }
      }
    }
    return count;
  }

  private internChild<K, V>(
    parent: Context,
    handle: Analysis<K, V>,
    key: K,
    value: V,
  ): Context {
    const handleAsKey = handle as unknown as Analysis<any, any>;
    let byHandle = this.children.get(parent);
    if (byHandle === undefined) {
      byHandle = new Map();
      this.children.set(parent, byHandle);
    }
    let byKey = byHandle.get(handleAsKey);
    if (byKey === undefined) {
      byKey = new Map();
      byHandle.set(handleAsKey, byKey);
    }
    let bucket = byKey.get(key);
    if (bucket === undefined) {
      bucket = [];
      byKey.set(key, bucket);
    }
    for (const entry of bucket) {
      if (handle.lattice.eq(entry.value as V, value)) return entry.node;
    }
    const node: Context = Object.freeze({
      parent,
      assumption: Object.freeze({
        analysis: handle as Analysis<unknown, unknown>,
        key: key as unknown,
        value: value as unknown,
      }),
      depth: parent.depth + 1,
    });
    bucket.push({ value, node });
    return node;
  }

  /** Flatten parent chain, dedup at `(handle, key)` keeping the new value,
   *  sort canonically, and intern. Used when the new assumption sorts before
   *  an existing one or collides at the same `(handle, key)`. */
  private rebuildWith<K, V>(
    parent: Context,
    handle: Analysis<K, V>,
    key: K,
    value: V,
  ): Context {
    const links: Assumption[] = [];
    const handleAsKey = handle as unknown as Analysis<unknown, unknown>;
    for (let cur: Context | undefined = parent; cur !== undefined; cur = cur.parent) {
      const a = cur.assumption;
      if (a === undefined) continue;
      if (a.analysis === handleAsKey && a.key === key) continue;
      links.push(a);
    }
    links.push({
      analysis: handleAsKey,
      key: key as unknown,
      value: value as unknown,
    });
    links.sort(compareAssumption);
    return this.internList(links);
  }

  private internList(sorted: ReadonlyArray<Assumption>): Context {
    let cur: Context = ROOT_CONTEXT;
    for (const a of sorted) {
      cur = this.internChild(cur, a.analysis, a.key, a.value);
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
