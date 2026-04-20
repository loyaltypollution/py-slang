// Per-Analysis, context-partitioned storage.
//
// The three storage concerns live in one explicit owner:
//
//   1. Context-partitioned cells (`Map<AssumptionChain, Map<K, V>>`).
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

import type { Analysis, JoinSemiLattice, Reading } from "./analysis";
import type { AssumptionChain } from "./context";

export interface ReadonlyAnalysisStore<K, V> {
  read(key: K, context: AssumptionChain): V;
  tryRead(key: K, context: AssumptionChain): V | undefined;
  readAll(context: AssumptionChain): ReadonlyMap<K, V>;
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
  readonly context: AssumptionChain;
  readonly oldValue: V | undefined;
  readonly newValue: V;
}

const EMPTY_MAP: ReadonlyMap<unknown, unknown> = new Map();

export class AnalysisStore<K, V> implements ReadonlyAnalysisStore<K, V> {
  private readonly cellsByContext = new Map<AssumptionChain, Map<K, V>>();

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
  read(key: K, context: AssumptionChain): V {
    const cells = this.cellsByContext.get(context);
    if (cells === undefined || !cells.has(key)) {
      return this.emptyValue ?? this.algebra.bottom;
    }
    return cells.get(key) as V;
  }

  /** Cell value under `context`, or `undefined` if the cell is unwritten.
   *  Distinguishes "unwritten" from "written to bottom". `context` is
   *  mandatory — see `read`. */
  tryRead(key: K, context: AssumptionChain): V | undefined {
    return this.cellsByContext.get(context)?.get(key);
  }

  /** Every written cell under `context`. Returns the backing Map as a
   *  readonly view — mutation via the cast is a bug. Empty Map when no
   *  writes have landed under `context`. `context` is mandatory — see `read`. */
  readAll(context: AssumptionChain): ReadonlyMap<K, V> {
    return (this.cellsByContext.get(context) ?? EMPTY_MAP) as ReadonlyMap<K, V>;
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
   *  which context-tree node it meant to land in. */
  write(key: K, value: V, context: AssumptionChain): StoreWriteResult<V> | null {
    let cells = this.cellsByContext.get(context);
    if (cells === undefined) {
      cells = new Map();
      this.cellsByContext.set(context, cells);
    }
    const hadPrev = cells.has(key);
    const prev = hadPrev ? (cells.get(key) as V) : undefined;
    const next = hadPrev ? this.algebra.join(prev as V, value) : value;
    if (hadPrev && this.algebra.eq(next, prev as V)) return null;
    cells.set(key, next);
    return { prev, next };
  }

  /** Delete a single cell. Silent if absent. `context` is mandatory —
   *  see `read`. */
  evict(key: K, context: AssumptionChain): void {
    this.cellsByContext.get(context)?.delete(key);
  }

  /** Drop every cell under `context` in one operation. Silent if the partition
   *  is empty or absent. Used to reclaim memory from synthetic probe contexts
   *  whose cells were written by speculative Kildall drains and are no longer
   *  needed. */
  clearContext(context: AssumptionChain): void {
    this.cellsByContext.delete(context);
  }

  /** Every context that currently owns at least one backing cell map.
   *  Primarily for lifecycle cleanup that must sweep across speculative and
   *  ROOT partitions alike (e.g. evicting stale block cells on CFG rebuild or
   *  unit retire). Returned iterable is a snapshot: callers may evict while
   *  iterating without mutating the traversal. */
  contexts(): ReadonlyArray<AssumptionChain> {
    return Array.from(this.cellsByContext.keys());
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
  context: AssumptionChain,
): StoreWriteResult<V> | null {
  return (store as AnalysisStore<K, V>).write(key, value, context);
}

/** Framework-internal eviction hook. */
export function storeEvict<K, V>(
  store: ReadonlyAnalysisStore<K, V>,
  key: K,
  context: AssumptionChain,
): void {
  (store as AnalysisStore<K, V>).evict(key, context);
}

/** Framework-internal enumeration of context partitions. */
export function storeContexts<K, V>(
  store: ReadonlyAnalysisStore<K, V>,
): ReadonlyArray<AssumptionChain> {
  return (store as AnalysisStore<K, V>).contexts();
}

/** Exact positional read labeled with its witness. `store.read` supplies the
 *  semantic default for unwritten cells at that exact context. */
export function storeReadAt<K, V>(
  store: ReadonlyAnalysisStore<K, V>,
  key: K,
  context: AssumptionChain,
): Reading<V> {
  return {
    value: store.read(key, context),
    witness: context,
  };
}

/** Walk `from → ROOT`, keeping the shallowest ancestor whose exact written
 *  cell satisfies `accept`. Unwritten cells are skipped entirely so callers do
 *  not accidentally treat a missing speculative partition as proof borrowed
 *  from ROOT. */
export function storeReadMinimal<K, V>(
  store: ReadonlyAnalysisStore<K, V>,
  key: K,
  accept: (value: V) => boolean,
  from: AssumptionChain,
): Reading<V> | undefined {
  let match: Reading<V> | undefined;
  for (let cur: AssumptionChain | undefined = from; cur !== undefined; cur = cur.parent) {
    const value = store.tryRead(key, cur);
    if (value === undefined || !accept(value)) continue;
    match = { value, witness: cur };
  }
  return match;
}

/** Framework-internal bulk-eviction hook: drops the entire cell partition
 *  under `context`. Used by `Worklist.lineageOf` to release the synthetic
 *  pruned-context cells that `rebuildWith`-free Kildall probes write — those
 *  probes are throwaway and no caller retains references. Silent if no
 *  partition exists. */
export function storeClearContext<K, V>(
  store: ReadonlyAnalysisStore<K, V>,
  context: AssumptionChain,
): void {
  (store as AnalysisStore<K, V>).clearContext(context);
}
