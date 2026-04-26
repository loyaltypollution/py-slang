// Per-Analysis, context-partitioned storage. `analysis.store` is the public
// readonly surface; framework writes go through `storeWrite`.

import type { JoinSemiLattice } from "./analysis";
import { isRoot, type AssumptionChain } from "../assumption/chain";

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
interface StoreWriteResult<V> {
  readonly prev: V | undefined;
  readonly next: V;
}

/** Shared readonly empty-map sentinel. Never mutated. */
export const EMPTY_MAP: ReadonlyMap<unknown, unknown> = new Map();

/** Walk `chain → ROOT`, returning either the shallowest ancestor whose
 *  `tryRead` hit satisfies `accept` (`mode: "minimal"`) or the deepest
 *  ancestor with any `tryRead` hit (`mode: "deepest"`). */
export function walkChain<K, V>(
  chain: AssumptionChain,
  key: K,
  tryRead: (key: K, context: AssumptionChain) => V | undefined,
  mode: "minimal" | "deepest",
  accept: (value: V) => boolean = () => true,
): { value: V; witness: AssumptionChain } | undefined {
  let match: { value: V; witness: AssumptionChain } | undefined;
  let cur: AssumptionChain = chain;
  while (true) {
    const value = tryRead(key, cur);
    if (value !== undefined && accept(value)) {
      if (mode === "deepest") return { value, witness: cur };
      match = { value, witness: cur };
    }
    if (isRoot(cur)) break;
    cur = cur.parent;
  }
  return match;
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

  tryRead(key: K, context: AssumptionChain): V | undefined {
    return this.cellsByContext.get(context)?.get(key);
  }

  readAll(context: AssumptionChain): ReadonlyMap<K, V> {
    return (this.cellsByContext.get(context) ?? EMPTY_MAP) as ReadonlyMap<K, V>;
  }

  readMinimal(
    chain: AssumptionChain,
    key: K,
    accept: (value: V) => boolean,
  ): { value: V; witness: AssumptionChain } | undefined {
    return walkChain(chain, key, (k, c) => this.tryRead(k, c), "minimal", accept);
  }

  readDeepest(
    chain: AssumptionChain,
    key: K,
  ): { value: V; witness: AssumptionChain } | undefined {
    return walkChain(chain, key, (k, c) => this.tryRead(k, c), "deepest");
  }

  /** Combine `value` with the existing cell via `algebra.join` and store.
   *  Returns `{prev, next}` when the cell advanced (eq-gated), else `null`. */
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

/** Framework-internal write hook. Public `Analysis.store` is readonly. */
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

/** Framework-internal context enumeration hook. */
export function storeContexts<K, V>(
  store: ReadonlyAnalysisStore<K, V>,
): IterableIterator<AssumptionChain> {
  return (store as AnalysisStore<K, V>).contexts();
}
