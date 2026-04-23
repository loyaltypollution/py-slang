// Canonicalizing interner for Speculation chains.
//
// `extendContext` used to allocate a fresh `Object.freeze({...})` per call; two
// observations producing the same assumption chain produced two distinct Speculation
// objects, fragmenting every Speculation-keyed data structure downstream
// (analysis-store cells, JIT IR cache, worklist pending-set). This interner
// canonicalizes:
//
//   1. Structural equality ⇒ reference equality. Repeating an observation
//      returns the same Speculation object — downstream Map<Speculation,_> structures
//      de-fragment automatically.
//
//   2. Assumption-set identity ⇒ chain identity, regardless of arrival order.
//      Chains are built in canonical order (per-interner narrowing ordinal,
//      then `compareKey(key)`). The ordinal is assigned lazily on first
//      sight of each narrowing, so canonical order is deterministic within
//      a process even though it is not stable across processes — chains are
//      not serialized, so cross-process determinism is not required. A
//      lineage-precise widen that prunes a middle link lands on a chain
//      that any prior compilation under the surviving assumption subset
//      would have produced — enabling sibling IR cache hits.
//
// Trie shape: `parent -> narrowing -> key -> ValueBucket`. A ValueBucket is a
// small array scanned linearly via `narrowing.eq`. Per-bucket cardinality is
// bounded by the distinct observed values at one (narrowing, nodeId) site
// (typically 1–3). `narrowing.eq` is the canonical structural equality for
// assumption values; using ref-equality here would fork the trie where it
// should have converged — `const(v)` from separate `liftConst` calls is
// structurally equal but reference-different.

import { type Narrowing } from "./analysis";
import type { Assumption, Speculation } from "./assumption-chain";
import { CHAIN_PROTO, ROOT_CONTEXT } from "./assumption-chain";

function compareKey(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

interface ValueEntry {
  readonly value: unknown;
  readonly node: Speculation;
}

export class ContextInterner {
  private readonly children: Map<
    Speculation,
    Map<Narrowing<any, any>, Map<unknown, ValueEntry[]>>
  > = new Map();

  /** Per-interner ordinal assigned to each Narrowing on first sight. Used as
   *  the primary sort key in `compareAssumption` so canonical chain order is
   *  deterministic per-process. Order is stable within a process — chains are
   *  not serialized, so cross-process determinism is not a requirement. */
  private readonly narrowingOrdinals: WeakMap<Narrowing<any, any>, number> = new WeakMap();
  private nextNarrowingOrdinal = 0;

  private ordinalOf(narrowing: Narrowing<any, any>): number {
    let n = this.narrowingOrdinals.get(narrowing);
    if (n === undefined) {
      n = this.nextNarrowingOrdinal++;
      this.narrowingOrdinals.set(narrowing, n);
    }
    return n;
  }

  private compareAssumption(a: Assumption, b: Assumption): number {
    const oa = this.ordinalOf(a.narrowing);
    const ob = this.ordinalOf(b.narrowing);
    if (oa !== ob) return oa - ob;
    return compareKey(a.key, b.key);
  }

  /** Extend `parent` with `(narrowing, key, value)`, returning a canonical
   *  Speculation. Equal values are dedup'd via the narrowing's
   *  value-equality relation; the caller does not supply an equality
   *  predicate.
   *
   *  Strict on conflict: throws if `parent` already binds `(narrowing, key)`
   *  to a value that differs from `value` under `narrowing.eq`. The
   *  worklist-level "retire + exclude + re-extend" flow handles genuine
   *  value changes; a direct `extend` conflict here means a bug at the
   *  caller. Idempotent when the already-bound value equals the new one. */
  extend<K, V>(
    parent: Speculation,
    narrowing: Narrowing<K, V>,
    key: K,
    value: V,
  ): Speculation {
    const parentAssumption = parent.assumption;
    if (parentAssumption === undefined) {
      return this.internChild(parent, narrowing, key, value);
    }
    const newLink: Assumption = {
      narrowing: narrowing as Narrowing<unknown, unknown>,
      key: key as unknown,
      value: value as unknown,
    };
    const cmp = this.compareAssumption(newLink, parentAssumption);
    if (cmp > 0) {
      return this.internChild(parent, narrowing, key, value);
    }
    // cmp === 0: new link matches parent's tip on (narrowing, key). Either
    // the value agrees (idempotent — return parent) or it conflicts.
    if (cmp === 0) {
      if (narrowing.eq(parentAssumption.value as V, value)) return parent;
      throw new Error(
        "assumption-algebra: extend conflicts with existing binding at same (narrowing, key). " +
          "Use without(s, narrowing, key) first if the old value is being replaced.",
      );
    }
    // cmp < 0: sorts earlier than parent's tip — must rebuild. Mid-chain
    // conflicts are detected in rebuildWith.
    return this.rebuildWith(parent, narrowing, key, value);
  }

  /** Remove every link at `(narrowing, key)` from `ctx`. Identity-returns
   *  `ctx` when no link matches — callers can short-circuit on reference
   *  equality. The canonical invariant guarantees at most one match
   *  (collisions at the same `(narrowing, key)` are replaced at
   *  extend-time, not layered). */
  exclude<K>(ctx: Speculation, narrowing: Narrowing<K, any>, key: K): Speculation {
    const narrowingAsKey = narrowing as unknown as Narrowing<unknown, unknown>;
    const links: Assumption[] = [];
    let found = false;
    for (let cur: Speculation | undefined = ctx; cur !== undefined; cur = cur.parent) {
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
    let result: Speculation = ROOT_CONTEXT;
    for (let i = links.length - 1; i >= 0; i--) {
      const a = links[i];
      result = this.internChild(result, a.narrowing, a.key as never, a.value as never);
    }
    return result;
  }

  /** Remove `ctx` from the interner's trie. After release, a future
   *  `extend` with the same `(parent, narrowing, key, value)` allocates a
   *  fresh chain node — reference equality with any previously-held handle
   *  is lost. Callers must only release a chain they know nothing else
   *  references, after it has evicted every analysis-store partition and
   *  forked body keyed by `ctx`.
   *
   *  Does NOT walk ancestors. Ancestors may still be retained by sibling
   *  chains (interned under the same parent) or by other units' dispatch
   *  contexts; the interner lacks the cross-reference bookkeeping to
   *  discover when an ancestor becomes reclaimable. This is the conservative
   *  choice — a missed eviction higher up the trie wastes memory but does
   *  not fragment downstream data structures. */
  release(ctx: Speculation): void {
    const a = ctx.assumption;
    if (a === undefined) return; // ROOT: never interned, never freed.
    const parent = ctx.parent;
    if (parent === undefined) return;
    const byNarrowing = this.children.get(parent);
    if (byNarrowing === undefined) return;
    const byKey = byNarrowing.get(a.narrowing);
    if (byKey === undefined) return;
    const bucket = byKey.get(a.key);
    if (bucket === undefined) return;
    const idx = bucket.findIndex(entry => entry.node === ctx);
    if (idx === -1) return;
    bucket.splice(idx, 1);
    if (bucket.length === 0) {
      byKey.delete(a.key);
      if (byKey.size === 0) {
        byNarrowing.delete(a.narrowing);
        if (byNarrowing.size === 0) this.children.delete(parent);
      }
    }
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
    parent: Speculation,
    narrowing: Narrowing<K, V>,
    key: K,
    value: V,
  ): Speculation {
    const narrowingAsKey = narrowing as unknown as Narrowing<any, any>;
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
    const assumption = Object.freeze({
      narrowing: narrowing as Narrowing<unknown, unknown>,
      key: key as unknown,
      value: value as unknown,
    });
    // Build the child's content-addressed bindings from parent's, extended
    // with the new tip. Clone only the outer Map and the inner Map under
    // `narrowing`; other inner Maps are shared read-only.
    const bindings = new Map(parent.bindings);
    const parentInner = parent.bindings.get(narrowingAsKey);
    const inner = parentInner !== undefined ? new Map(parentInner) : new Map();
    inner.set(key as unknown, assumption);
    bindings.set(narrowingAsKey, inner);
    const node: Speculation = Object.freeze(
      Object.assign(Object.create(CHAIN_PROTO), {
        parent,
        assumption,
        depth: parent.depth + 1,
        bindings,
      }) as Speculation,
    );
    bucket.push({ value, node });
    return node;
  }

  /** Flatten parent chain, sort canonically, and intern. Called when the
   *  new assumption sorts before parent's tip.
   *
   *  If the parent chain already binds `(narrowing, key)` mid-chain, the
   *  existing value must agree with the new one under `narrowing.eq`
   *  (idempotent re-extend). A conflicting mid-chain value throws — the
   *  caller should `without(s, narrowing, key)` first. */
  private rebuildWith<K, V>(
    parent: Speculation,
    narrowing: Narrowing<K, V>,
    key: K,
    value: V,
  ): Speculation {
    const links: Assumption[] = [];
    const narrowingAsKey = narrowing as unknown as Narrowing<unknown, unknown>;
    for (let cur: Speculation | undefined = parent; cur !== undefined; cur = cur.parent) {
      const a = cur.assumption;
      if (a === undefined) continue;
      if (a.narrowing === narrowingAsKey && a.key === key) {
        if (narrowing.eq(a.value as V, value)) continue;
        throw new Error(
          "assumption-algebra: extend conflicts with existing binding mid-chain at same (narrowing, key). " +
            "Use without(s, narrowing, key) first if the old value is being replaced.",
        );
      }
      links.push(a);
    }
    links.push({
      narrowing: narrowingAsKey,
      key: key as unknown,
      value: value as unknown,
    });
    links.sort((a, b) => this.compareAssumption(a, b));
    return this.internList(links);
  }

  private internList(sorted: ReadonlyArray<Assumption>): Speculation {
    let cur: Speculation = ROOT_CONTEXT;
    for (const a of sorted) {
      cur = this.internChild(cur, a.narrowing, a.key, a.value);
    }
    return cur;
  }
}

export const defaultInterner = new ContextInterner();
