// Per-Analysis, context-partitioned storage.
//
// The three storage concerns live in one explicit owner:
//
//   1. Context-partitioned cells (`Map<Speculation, Map<K, V>>`).
//   2. Algebra-gated writes (`join(prev, value)` + `eq(joined, prev)`
//      advance-check).
//   3. Unwritten-cell default (`emptyValue` or `algebra.bottom`).
//
// Each `Analysis<K, V>` owns one `AnalysisStore` via `analysis.store` (set
// at `defineAnalysis` time). Transfers/effects access it through
// `AnalysisCtx.read/tryRead/readAll/write/evict` so writes go through the
// worklist's change-dispatch list. Public `analysis.store` is read-only;
// framework-owned writes go through `storeWrite(...)` so external holders
// cannot silently bypass listener fan-out.

import type { Analysis, JoinSemiLattice } from "./analysis";
import type { Speculation } from "./assumption-chain";

export interface ReadonlyAnalysisStore<K, V> {
  read(key: K, context: Speculation): V;
  tryRead(key: K, context: Speculation): V | undefined;
  readAll(context: Speculation): ReadonlyMap<K, V>;
  readMinimal(
    chain: Speculation,
    key: K,
    accept: (value: V) => boolean,
  ): { value: V; witness: Speculation } | undefined;
  readDeepest(
    chain: Speculation,
    key: K,
  ): { value: V; witness: Speculation } | undefined;
}

/** Result of an advancing write. `null` from `AnalysisStore.write` means
 *  the cell did not advance and no event should fire. The worklist lifts
 *  this into a `FactChange` for the dispatch list. */
export interface StoreWriteResult<V> {
  readonly prev: V | undefined;
  readonly next: V;
}

/** Fired on value-changing writes. Distributed by the worklist's
 *  `onChange` list. `oldValue` is `undefined` if the cell was empty.
 *  `context` identifies the speculation-assumption chain the cell lives
 *  under; ROOT_CONTEXT = no assumptions. */
export interface FactChange<K, V> {
  readonly analysis: Analysis<K, V>;
  readonly key: K;
  readonly context: Speculation;
  readonly oldValue: V | undefined;
  readonly newValue: V;
}

const EMPTY_MAP: ReadonlyMap<unknown, unknown> = new Map();

/** Walk `chain → ROOT`, returning the shallowest ancestor whose `tryRead`
 *  hit satisfies `accept`. Shared between `AnalysisStore` and synthetic
 *  store adapters (e.g. the DFA factory's `perExpr` node-keyed view) so the
 *  speculation-chain walk is named in one place. */
export function walkChainMinimal<K, V>(
  chain: Speculation,
  key: K,
  tryRead: (key: K, context: Speculation) => V | undefined,
  accept: (value: V) => boolean,
): { value: V; witness: Speculation } | undefined {
  let match: { value: V; witness: Speculation } | undefined;
  for (let cur: Speculation | undefined = chain; cur !== undefined; cur = cur.parent) {
    const value = tryRead(key, cur);
    if (value === undefined || !accept(value)) continue;
    match = { value, witness: cur };
  }
  return match;
}

/** Walk `chain → ROOT`, returning the deepest ancestor with a `tryRead` hit.
 *  See `walkChainMinimal` for rationale. */
export function walkChainDeepest<K, V>(
  chain: Speculation,
  key: K,
  tryRead: (key: K, context: Speculation) => V | undefined,
): { value: V; witness: Speculation } | undefined {
  for (let cur: Speculation | undefined = chain; cur !== undefined; cur = cur.parent) {
    const value = tryRead(key, cur);
    if (value !== undefined) return { value, witness: cur };
  }
  return undefined;
}

export class AnalysisStore<K, V> implements ReadonlyAnalysisStore<K, V> {
  private readonly cellsByContext = new Map<Speculation, Map<K, V>>();

  constructor(
    private readonly algebra: JoinSemiLattice<V>,
    private readonly emptyValue: V | undefined,
  ) {}

  /** Cell value under `context`, or the algebra's default for unwritten.
   *  `context` is mandatory: ROOT is one position in the interned context
   *  tree, not a safe fallback. Callers that want the semantic fact pass
   *  `ROOT_CONTEXT` explicitly; callers that want a non-ROOT position pass
   *  that position. Making it implicit historically turned "forgot to
   *  thread the speculative context" into a silent ROOT read — exactly the
   *  review-by-folklore seam the transform-boundary audit flagged. */
  read(key: K, context: Speculation): V {
    const cells = this.cellsByContext.get(context);
    if (cells !== undefined) {
      const hit = cells.get(key);
      // Distinguish "unwritten" from "written to a falsy value" via `has`
      // only when `get` returns undefined.
      if (hit !== undefined || cells.has(key)) return hit as V;
    }
    return this.emptyValue ?? this.algebra.bottom;
  }

  /** Cell value under `context`, or `undefined` if the cell is unwritten.
   *  Distinguishes "unwritten" from "written to bottom". `context` is
   *  mandatory — see `read`. */
  tryRead(key: K, context: Speculation): V | undefined {
    return this.cellsByContext.get(context)?.get(key);
  }

  /** Every written cell under `context`. Returns the backing Map as a
   *  readonly view — mutation via the cast is a bug. Empty Map when no
   *  writes have landed under `context`. `context` is mandatory — see `read`. */
  readAll(context: Speculation): ReadonlyMap<K, V> {
    return (this.cellsByContext.get(context) ?? EMPTY_MAP) as ReadonlyMap<K, V>;
  }

  readMinimal(
    chain: Speculation,
    key: K,
    accept: (value: V) => boolean,
  ): { value: V; witness: Speculation } | undefined {
    return walkChainMinimal(chain, key, (k, c) => this.tryRead(k, c), accept);
  }

  readDeepest(
    chain: Speculation,
    key: K,
  ): { value: V; witness: Speculation } | undefined {
    return walkChainDeepest(chain, key, (k, c) => this.tryRead(k, c));
  }

  /** Combine `value` with the existing cell via `algebra.join` and store
   *  the result. Returns `{prev, next}` when the cell advanced (`!eq(next,
   *  prev)`), or `null` when the combined value is algebra-equal to `prev`
   *  and the write is a no-op.
   *
   *  No listener fan-out here; the worklist's `writeAndDispatch` (reached
   *  via `ctx.write`) publishes events based on the return value so
   *  change-dispatch stays centralized. `context` is mandatory: the store
   *  never invents a default position on behalf of a writer that forgot
   *  which context-tree node it meant to land in.
   *
   *  No-op gating is eq-based, not leq-based. For a must-style algebra that
   *  takes `min` as `join`, an incoming `value` with `leq(value, prev)` is
   *  still advancing — the cell moves to `min(prev, value)` and `write`
   *  returns `{prev, next}`. Callers must not short-circuit on `leq(value,
   *  prev)` as a no-op predicate; only the algebra's `eq` decides. */
  write(key: K, value: V, context: Speculation): StoreWriteResult<V> | null {
    let cells = this.cellsByContext.get(context);
    if (cells === undefined) {
      // First-ever write under `context`: fresh partition, no eq-check possible.
      cells = new Map();
      this.cellsByContext.set(context, cells);
      cells.set(key, value);
      return { prev: undefined, next: value };
    }
    // Single Map lookup on the hot path (value is defined). Only the rare
    // written-to-undefined case (kept legal by `read`'s has-based fallback)
    // pays a second lookup to disambiguate.
    const prev = cells.get(key);
    if (prev === undefined && !cells.has(key)) {
      cells.set(key, value);
      return { prev: undefined, next: value };
    }
    const next = this.algebra.join(prev as V, value);
    if (this.algebra.eq(next, prev as V)) return null;
    cells.set(key, next);
    return { prev, next };
  }

  /** Delete a single cell. Silent if absent. `context` is mandatory —
   *  see `read`. */
  evict(key: K, context: Speculation): void {
    this.cellsByContext.get(context)?.delete(key);
  }

  /** Drop every cell under `context` in one operation. Silent if the partition
   *  is empty or absent. Used to reclaim memory from synthetic probe contexts
   *  whose cells were written by speculative Kildall drains and are no longer
   *  needed. */
  clearContext(context: Speculation): void {
    this.cellsByContext.delete(context);
  }

  /** Every context that currently owns at least one backing cell map.
   *  Primarily for lifecycle cleanup that must sweep across speculative and
   *  ROOT partitions alike (e.g. evicting stale block cells on CFG rebuild or
   *  unit retire).
   *
   *  Returns the Map's own `keys()` iterator — zero-allocation. JS `Map`
   *  iteration tolerates `delete(key)` during traversal (deleted keys are
   *  never revisited), so callers may evict individual cells or even
   *  `clearContext` the current key while iterating. What callers must NOT
   *  do is add new contexts mid-traversal and expect them to be visited;
   *  snapshot manually (`[...store.contexts()]`) at the call site if that
   *  matters. No current caller relies on snapshot semantics. */
  contexts(): IterableIterator<Speculation> {
    return this.cellsByContext.keys();
  }
}

/** Framework-internal mutation hook. `Analysis.store` is typed as the
 *  readonly surface so external holders cannot silently bypass worklist
 *  dispatch by calling `.write` themselves. Internal code that truly owns the
 *  write path goes through this helper instead. */
export function storeWrite<K, V>(
  store: ReadonlyAnalysisStore<K, V>,
  key: K,
  value: V,
  context: Speculation,
): StoreWriteResult<V> | null {
  return (store as AnalysisStore<K, V>).write(key, value, context);
}

/** Framework-internal eviction hook. */
export function storeEvict<K, V>(
  store: ReadonlyAnalysisStore<K, V>,
  key: K,
  context: Speculation,
): void {
  (store as AnalysisStore<K, V>).evict(key, context);
}

/** Framework-internal enumeration of context partitions. See
 *  `AnalysisStore.contexts` for iteration/mutation rules. */
export function storeContexts<K, V>(
  store: ReadonlyAnalysisStore<K, V>,
): IterableIterator<Speculation> {
  return (store as AnalysisStore<K, V>).contexts();
}


