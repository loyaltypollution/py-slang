export interface NarrowingId<K = unknown, V = unknown> {
  eq(a: V, b: V): boolean;
  readonly __narrowingBrand?: () => readonly [K, V];
}

export interface Assumption<K = unknown, V = unknown> {
  readonly narrowing: NarrowingId<K, V>;
  readonly key: K;
  readonly value: V;
}

type Bindings = ReadonlyMap<NarrowingId<any, any>, ReadonlyMap<unknown, Assumption>>;

interface AssumptionRoot {
  readonly depth: 0;
  readonly bindings: Bindings;
}

/** A non-root chain: one assumption pinned on top of a parent. `extend`
 *  and `carrier` return this directly so callers don't re-narrow. */
export interface AssumptionBranch {
  readonly parent: AssumptionChain;
  readonly assumption: Assumption;
  readonly depth: number;
  readonly bindings: Bindings;
}

export type AssumptionChain = AssumptionRoot | AssumptionBranch;

export const ROOT_CONTEXT: AssumptionChain = Object.freeze({
  depth: 0,
  bindings: new Map(),
});

export function isRoot(ctx: AssumptionChain): ctx is AssumptionRoot {
  return !("parent" in ctx);
}

// ---- canonicalization state -------------------------------------------------

interface ValueEntry {
  readonly value: unknown;
  readonly node: AssumptionBranch;
}

/** Child trie: `parent → narrowing → key → bucket of (value, node)`. The
 *  bucket disambiguates structurally-equal-but-not-`===` values via
 *  `narrowing.eq`. */
type ChildTrie = Map<AssumptionChain, Map<NarrowingId<any, any>, Map<unknown, ValueEntry[]>>>;
const children: ChildTrie = new Map();

const narrowingOrdinals: WeakMap<NarrowingId<any, any>, number> = new WeakMap();
let nextNarrowingOrdinal = 0;

function ordinalOf(narrowing: NarrowingId<any, any>): number {
  let n = narrowingOrdinals.get(narrowing);
  if (n === undefined) {
    n = nextNarrowingOrdinal++;
    narrowingOrdinals.set(narrowing, n);
  }
  return n;
}

/** Stable order over (axis, key): axis-ordinal first, then numeric or
 *  lexicographic key. Determines whether `extend` appends or rebuilds. */
function compareFacts(a: Assumption, b: Assumption): number {
  const oa = ordinalOf(a.narrowing);
  const ob = ordinalOf(b.narrowing);
  if (oa !== ob) return oa - ob;
  if (typeof a.key === "number" && typeof b.key === "number") return a.key - b.key;
  const sa = String(a.key);
  const sb = String(b.key);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function getOrCreate<K, V>(map: Map<K, V>, key: K, makeEmpty: () => V): V {
  let v = map.get(key);
  if (v === undefined) {
    v = makeEmpty();
    map.set(key, v);
  }
  return v;
}

/** Bindings map for `parent` extended with `assumption`. */
function bindingsExtended(parent: AssumptionChain, assumption: Assumption): Bindings {
  const out = new Map(parent.bindings);
  const inner = new Map(parent.bindings.get(assumption.narrowing) ?? []);
  inner.set(assumption.key, assumption);
  out.set(assumption.narrowing, inner);
  return out;
}

function freezeAssumption<K, V>(
  narrowing: NarrowingId<K, V>,
  key: K,
  value: V,
): Assumption {
  return Object.freeze({
    narrowing: narrowing as NarrowingId<unknown, unknown>,
    key: key as unknown,
    value: value as unknown,
  });
}

/** Intern (or reuse) the child of `parent` carrying `narrowing@key = value`. */
function internChild<K, V>(
  parent: AssumptionChain,
  narrowing: NarrowingId<K, V>,
  key: K,
  value: V,
): AssumptionBranch {
  const byNarrowing = getOrCreate(children, parent, () => new Map());
  const byKey = getOrCreate(byNarrowing, narrowing, () => new Map());
  const bucket = getOrCreate(byKey, key, () => [] as ValueEntry[]);

  for (const entry of bucket) {
    if (narrowing.eq(entry.value as V, value)) return entry.node;
  }

  const assumption = freezeAssumption(narrowing, key, value);
  const node: AssumptionBranch = Object.freeze({
    parent,
    assumption,
    depth: parent.depth + 1,
    bindings: bindingsExtended(parent, assumption),
  });
  bucket.push({ value, node });
  return node;
}

/** Build the canonical chain whose fact set is `facts` (in axis order). */
function chainFromFacts(facts: readonly Assumption[]): AssumptionBranch {
  let cur: AssumptionChain = ROOT_CONTEXT;
  for (const f of facts) {
    cur = internChild(cur, f.narrowing, f.key, f.value);
  }
  // facts is non-empty in every caller, so cur is an AssumptionLink.
  return cur as AssumptionBranch;
}

/** Walk `s`'s facts, throwing on any conflict with a same-(axis, key)
 *  pinning whose value disagrees with `incoming`. */
function factsExcept(
  s: AssumptionChain,
  incoming: Assumption,
): { kept: Assumption[]; dropped: boolean } {
  const kept: Assumption[] = [];
  let dropped = false;
  for (let cur: AssumptionChain = s; !isRoot(cur); cur = cur.parent) {
    const a = cur.assumption;
    if (a.narrowing === incoming.narrowing && a.key === incoming.key) {
      if (incoming.narrowing.eq(a.value, incoming.value)) {
        // same fact already pinned — drop the incoming, keep nothing extra
        dropped = true;
        continue;
      }
      throw new Error("assumption/chain: extend conflicts with existing binding");
    }
    kept.push(a);
  }
  return { kept, dropped };
}

// ---- public operations ------------------------------------------------------

/** Pin `narrowing@key = value` onto `s`. Idempotent on (axis, key, value);
 *  throws if the same (axis, key) is already pinned to a different value
 *  (callers must `without` first). Order-independent. */
export function extend<K, V>(
  s: AssumptionChain,
  narrowing: NarrowingId<K, V>,
  key: K,
  value: V,
): AssumptionBranch {
  if (isRoot(s)) return internChild(s, narrowing, key, value);

  const incoming = freezeAssumption(narrowing, key, value);
  const cmp = compareFacts(incoming, s.assumption);

  // append: incoming sorts after the tip — no rebuild needed.
  if (cmp > 0) return internChild(s, narrowing, key, value);

  // same (axis, key) at tip: idempotent or conflict.
  if (cmp === 0) {
    if (narrowing.eq(s.assumption.value as V, value)) return s;
    throw new Error("assumption/chain: extend conflicts with existing binding");
  }

  // incoming sorts earlier than the tip — rebuild from root in axis order.
  const { kept } = factsExcept(s, incoming);
  kept.push(incoming);
  kept.sort(compareFacts);
  return chainFromFacts(kept);
}

/** Drop the pinning at `narrowing@key`. Returns `s` unchanged if no such
 *  pinning exists; otherwise the canonical sibling without it. */
export function without<K>(
  s: AssumptionChain,
  narrowing: NarrowingId<K, any>,
  key: K,
): AssumptionChain {
  const kept: Assumption[] = [];
  let found = false;
  for (let cur: AssumptionChain = s; !isRoot(cur); cur = cur.parent) {
    const a = cur.assumption;
    if (a.narrowing === narrowing && a.key === key) {
      found = true;
      continue;
    }
    kept.push(a);
  }
  if (!found) return s;
  if (kept.length === 0) return ROOT_CONTEXT;
  // The walk produced kept in tip→root order; chainFromFacts wants root→tip.
  kept.reverse();
  return chainFromFacts(kept);
}

/** Value pinned at `narrowing@key` on `s`, or `undefined` if not pinned. */
export function at<K, V>(
  s: AssumptionChain,
  narrowing: NarrowingId<K, V>,
  key: K,
): V | undefined {
  return s.bindings.get(narrowing)?.get(key)?.value as V | undefined;
}

/** Ancestor link whose own `assumption` is the pinning at `narrowing@key`,
 *  or `undefined` if not pinned. Used by refutation to identify the carrier
 *  of the doomed fact. */
export function carrier<K>(
  s: AssumptionChain,
  narrowing: NarrowingId<K, any>,
  key: K,
): AssumptionBranch | undefined {
  for (let cur: AssumptionChain = s; !isRoot(cur); cur = cur.parent) {
    const a = cur.assumption;
    if (a.narrowing === narrowing && a.key === key) return cur;
  }
  return undefined;
}

/** `x ⊑ y` iff every fact pinned in `x` is pinned in `y` to a value-equal
 *  fact. */
export function leq(x: AssumptionChain, y: AssumptionChain): boolean {
  if (x === y) return true;
  if (x.depth > y.depth) return false;
  for (const [narrowing, xInner] of x.bindings) {
    const yInner = y.bindings.get(narrowing);
    if (yInner === undefined) return false;
    for (const [key, xa] of xInner) {
      const ya = yInner.get(key);
      if (ya === undefined) return false;
      if (!narrowing.eq(xa.value, ya.value)) return false;
    }
  }
  return true;
}

/** Iterate every fact pinned in `s`, in no guaranteed order. */
export function* bindings(s: AssumptionChain): Generator<Assumption> {
  for (const inner of s.bindings.values()) yield* inner.values();
}

/** Test-only: total interned chain count. Consumed by
 *  `assumption-chain-interner.test.ts` to assert dedup. */
export function debugChainNodeCount(): number {
  let count = 0;
  for (const byNarrowing of children.values()) {
    for (const byKey of byNarrowing.values()) {
      for (const bucket of byKey.values()) {
        count += bucket.length;
      }
    }
  }
  return count;
}
