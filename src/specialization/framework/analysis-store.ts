// Per-Analysis, context-partitioned storage. Public `analysis.store` is the
// readonly surface; framework-owned writes go through `storeWrite(...)`.

import type { Analysis, JoinSemiLattice } from "./analysis";
import type { AssumptionChain } from "../lattice/chain";

export interface ReadonlyAnalysisStore<K, V> {
  read(key: K, context: AssumptionChain): V;
  tryRead(key: K, context: AssumptionChain): V | undefined;
  readAll(context: AssumptionChain): ReadonlyMap<K, V>;
  readMinimal(
    chain: AssumptionChain,
    key: K,
    accept: (value: V) => boolean,
  ): { value: V; witness: AssumptionChain } | undefined;
  readDeepest(
    chain: AssumptionChain,
    key: K,
  ): { value: V; witness: AssumptionChain } | undefined;
}

/** Result of an advancing write. `null` means the cell did not advance. */
export interface StoreWriteResult<V> {
  readonly prev: V | undefined;
  readonly next: V;
}

/** Fired on value-changing writes. `oldValue` is `undefined` if the cell
 *  was empty. `context` identifies the speculation-assumption chain. */
export interface FactChange<K, V> {
  readonly analysis: Analysis<K, V>;
  readonly key: K;
  readonly context: AssumptionChain;
  readonly oldValue: V | undefined;
  readonly newValue: V;
}

const EMPTY_MAP: ReadonlyMap<unknown, unknown> = new Map();

/** Walk `chain → ROOT`, returning the shallowest ancestor whose `tryRead`
 *  hit satisfies `accept`. */
export function walkChainMinimal<K, V>(
  chain: AssumptionChain,
  key: K,
  tryRead: (key: K, context: AssumptionChain) => V | undefined,
  accept: (value: V) => boolean,
): { value: V; witness: AssumptionChain } | undefined {
  let match: { value: V; witness: AssumptionChain } | undefined;
  for (let cur: AssumptionChain | undefined = chain; cur !== undefined; cur = cur.parent) {
    const value = tryRead(key, cur);
    if (value !== undefined && accept(value)) match = { value, witness: cur };
  }
  return match;
}

/** Walk `chain → ROOT`, returning the deepest ancestor with a `tryRead` hit. */
export function walkChainDeepest<K, V>(
  chain: AssumptionChain,
  key: K,
  tryRead: (key: K, context: AssumptionChain) => V | undefined,
): { value: V; witness: AssumptionChain } | undefined {
  for (let cur: AssumptionChain | undefined = chain; cur !== undefined; cur = cur.parent) {
    const value = tryRead(key, cur);
    if (value !== undefined) return { value, witness: cur };
  }
  return undefined;
}

export class AnalysisStore<K, V> implements ReadonlyAnalysisStore<K, V> {
  private readonly cellsByContext = new Map<AssumptionChain, Map<K, V>>();

  constructor(
    private readonly algebra: JoinSemiLattice<V>,
    private readonly emptyValue: V | undefined,
  ) {}

  /** Cell value under `context`, or the algebra's default for unwritten. */
  read(key: K, context: AssumptionChain): V {
    const cells = this.cellsByContext.get(context);
    if (cells !== undefined) {
      const hit = cells.get(key);
      // Disambiguate "unwritten" from "written to undefined" via `has`.
      if (hit !== undefined || cells.has(key)) return hit as V;
    }
    return this.emptyValue ?? this.algebra.bottom;
  }

  /** Cell value under `context`, or `undefined` if unwritten. */
  tryRead(key: K, context: AssumptionChain): V | undefined {
    return this.cellsByContext.get(context)?.get(key);
  }

  /** Every written cell under `context` as a readonly view. */
  readAll(context: AssumptionChain): ReadonlyMap<K, V> {
    return (this.cellsByContext.get(context) ?? EMPTY_MAP) as ReadonlyMap<K, V>;
  }

  readMinimal(
    chain: AssumptionChain,
    key: K,
    accept: (value: V) => boolean,
  ): { value: V; witness: AssumptionChain } | undefined {
    return walkChainMinimal(chain, key, (k, c) => this.tryRead(k, c), accept);
  }

  readDeepest(
    chain: AssumptionChain,
    key: K,
  ): { value: V; witness: AssumptionChain } | undefined {
    return walkChainDeepest(chain, key, (k, c) => this.tryRead(k, c));
  }

  /** Combine `value` with the existing cell via `algebra.join` and store.
   *  Returns `{prev, next}` when the cell advanced, or `null` when
   *  `eq(next, prev)`. Gating is eq-based, not leq-based. */
  write(key: K, value: V, context: AssumptionChain): StoreWriteResult<V> | null {
    let cells = this.cellsByContext.get(context);
    if (cells === undefined) {
      cells = new Map();
      this.cellsByContext.set(context, cells);
      cells.set(key, value);
      return { prev: undefined, next: value };
    }
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

  /** Delete a single cell. Silent if absent. */
  evict(key: K, context: AssumptionChain): void {
    this.cellsByContext.get(context)?.delete(key);
  }

  /** Every context that currently owns at least one backing cell map.
   *  Returns the Map's own `keys()` iterator — deleting cells during
   *  traversal is safe; adding contexts mid-traversal is not. */
  contexts(): IterableIterator<AssumptionChain> {
    return this.cellsByContext.keys();
  }
}

/** Framework-internal mutation hook. Public `Analysis.store` is the
 *  readonly surface; internal write paths go through this helper. */
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
): IterableIterator<AssumptionChain> {
  return (store as AnalysisStore<K, V>).contexts();
}
