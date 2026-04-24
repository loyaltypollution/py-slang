// Canonicalizing interner for AssumptionChains.
// Structural equality ⇒ reference equality; arrival order doesn't matter
// (chains are sorted by per-interner narrowing ordinal, then key).

import type { Assumption, AssumptionChain, NarrowingId } from "./chain";
import { ROOT_CONTEXT } from "./chain";

interface ValueEntry {
  readonly value: unknown;
  readonly node: AssumptionChain;
}

export class ChainInterner {
  private readonly children: Map<
    AssumptionChain,
    Map<NarrowingId<any, any>, Map<unknown, ValueEntry[]>>
  > = new Map();

  private readonly narrowingOrdinals: WeakMap<NarrowingId<any, any>, number> = new WeakMap();
  private nextNarrowingOrdinal = 0;

  private ordinalOf(narrowing: NarrowingId<any, any>): number {
    let n = this.narrowingOrdinals.get(narrowing);
    if (n === undefined) {
      n = this.nextNarrowingOrdinal++;
      this.narrowingOrdinals.set(narrowing, n);
    }
    return n;
  }

  private compareByAxis(
    na: NarrowingId<any, any>,
    ka: unknown,
    nb: NarrowingId<any, any>,
    kb: unknown,
  ): number {
    const oa = this.ordinalOf(na);
    const ob = this.ordinalOf(nb);
    if (oa !== ob) return oa - ob;
    if (typeof ka === "number" && typeof kb === "number") return ka - kb;
    const sa = String(ka);
    const sb = String(kb);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  }

  extend<K, V>(
    parent: AssumptionChain,
    narrowing: NarrowingId<K, V>,
    key: K,
    value: V,
  ): AssumptionChain {
    const parentAssumption = parent.assumption;
    if (parentAssumption === undefined) {
      return this.internChild(parent, narrowing, key, value);
    }
    const cmp = this.compareByAxis(
      narrowing,
      key,
      parentAssumption.narrowing,
      parentAssumption.key,
    );
    if (cmp > 0) return this.internChild(parent, narrowing, key, value);
    if (cmp < 0) return this.rebuildWith(parent, narrowing, key, value);
    if (narrowing.eq(parentAssumption.value as V, value)) return parent;
    throw new Error("assumption/interner: extend conflicts with existing binding");
  }

  exclude<K>(ctx: AssumptionChain, narrowing: NarrowingId<K, any>, key: K): AssumptionChain {
    const links: Assumption[] = [];
    let found = false;
    for (let cur: AssumptionChain | undefined = ctx; cur !== undefined; cur = cur.parent) {
      const a = cur.assumption;
      if (a === undefined) continue;
      if (a.narrowing === narrowing && a.key === key) {
        found = true;
        continue;
      }
      links.push(a);
    }
    if (!found) return ctx;
    let result: AssumptionChain = ROOT_CONTEXT;
    for (let i = links.length - 1; i >= 0; i--) {
      const a = links[i];
      result = this.internChild(result, a.narrowing, a.key as never, a.value as never);
    }
    return result;
  }

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
    narrowing: NarrowingId<K, V>,
    key: K,
    value: V,
  ): AssumptionChain {
    let byNarrowing = this.children.get(parent);
    if (byNarrowing === undefined) {
      byNarrowing = new Map();
      this.children.set(parent, byNarrowing);
    }
    let byKey = byNarrowing.get(narrowing);
    if (byKey === undefined) {
      byKey = new Map();
      byNarrowing.set(narrowing, byKey);
    }
    let bucket = byKey.get(key);
    if (bucket === undefined) {
      bucket = [];
      byKey.set(key, bucket);
    }
    for (const entry of bucket) {
      if (narrowing.eq(entry.value as V, value)) return entry.node;
    }
    const assumption: Assumption = Object.freeze({
      narrowing: narrowing as NarrowingId<unknown, unknown>,
      key: key as unknown,
      value: value as unknown,
    });
    const bindings = new Map(parent.bindings);
    const parentInner = parent.bindings.get(narrowing);
    const inner: Map<unknown, Assumption> = parentInner !== undefined
      ? new Map(parentInner)
      : new Map();
    inner.set(key, assumption);
    bindings.set(narrowing, inner);
    const node: AssumptionChain = Object.freeze({
      parent,
      assumption,
      depth: parent.depth + 1,
      bindings,
    });
    bucket.push({ value, node });
    return node;
  }

  private rebuildWith<K, V>(
    parent: AssumptionChain,
    narrowing: NarrowingId<K, V>,
    key: K,
    value: V,
  ): AssumptionChain {
    const links: Assumption[] = [];
    for (let cur: AssumptionChain | undefined = parent; cur !== undefined; cur = cur.parent) {
      const a = cur.assumption;
      if (a === undefined) continue;
      if (a.narrowing === narrowing && a.key === key) {
        if (narrowing.eq(a.value as V, value)) continue;
        throw new Error("assumption/interner: extend conflicts with existing binding");
      }
      links.push(a);
    }
    links.push({
      narrowing: narrowing as NarrowingId<unknown, unknown>,
      key: key as unknown,
      value: value as unknown,
    });
    links.sort((a, b) => this.compareByAxis(a.narrowing, a.key, b.narrowing, b.key));
    let cur: AssumptionChain = ROOT_CONTEXT;
    for (const a of links) {
      cur = this.internChild(cur, a.narrowing, a.key, a.value);
    }
    return cur;
  }
}

export const defaultInterner = new ChainInterner();
