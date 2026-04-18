import type { Analysis } from "./analysis";

/** Fired on value-changing `(analysis, key)` writes. `oldValue` is `undefined` if the cell was empty. */
export interface FactChange<K, V> {
  readonly analysis: Analysis<K, V>;
  readonly key: K;
  readonly oldValue: V | undefined;
  readonly newValue: V;
}

type FactChangeListener = (change: FactChange<unknown, unknown>) => void;

/** Fact storage keyed by `(analysis, key)`. Writes are lattice-monotone: the stored
 *  cell is `join(prev, value)`, never `value` alone. A write where
 *  `leq(value, prev)` holds returns `false` and skips listener fan-out.
 *  Regressive writes (value ⊏ prev) collapse to no-ops rather than corrupting
 *  state. */
export class FactStore {
  private readonly cells = new Map<Analysis<unknown, unknown>, Map<unknown, unknown>>();
  private readonly listeners: FactChangeListener[] = [];

  read<K, V>(analysis: Analysis<K, V>, key: K): V {
    const inner = this.cells.get(analysis as Analysis<unknown, unknown>);
    if (inner === undefined || !inner.has(key)) return analysis.lattice.bottom;
    return inner.get(key) as V;
  }

  tryRead<K, V>(analysis: Analysis<K, V>, key: K): V | undefined {
    const inner = this.cells.get(analysis as Analysis<unknown, unknown>);
    if (inner === undefined || !inner.has(key)) return undefined;
    return inner.get(key) as V;
  }

  readAll<K, V>(analysis: Analysis<K, V>): ReadonlyMap<K, V> {
    const inner = this.cells.get(analysis as Analysis<unknown, unknown>);
    return (inner ?? new Map()) as ReadonlyMap<K, V>;
  }

  /** Write a fact. The stored value is `join(prev, value)`; a write that does
   *  not advance the lattice is a no-op. Returns `true` iff the cell advanced
   *  and a listener event fired. */
  write<K, V>(analysis: Analysis<K, V>, key: K, value: V): boolean {
    let inner = this.cells.get(analysis as Analysis<unknown, unknown>);
    if (inner === undefined) {
      inner = new Map();
      this.cells.set(analysis as Analysis<unknown, unknown>, inner);
    }

    const hadPrev = inner.has(key);
    const prev = hadPrev ? (inner.get(key) as V) : undefined;
    // Monotone lattice fast-path: leq(value, prev) ⇒ join(prev, value) = prev.
    if (hadPrev && analysis.lattice.leq(value, prev as V)) return false;
    const joined = hadPrev ? analysis.lattice.join(prev as V, value) : value;

    inner.set(key, joined);
    const change: FactChange<K, V> = {
      analysis,
      key,
      oldValue: prev,
      newValue: joined,
    };
    for (const l of this.listeners) l(change as FactChange<unknown, unknown>);
    return true;
  }

  /** Delete a cell. Silent if absent; no event emitted. */
  evict<K, V>(analysis: Analysis<K, V>, key: K): void {
    this.cells.get(analysis as Analysis<unknown, unknown>)?.delete(key);
  }

  onChange(listener: FactChangeListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx !== -1) this.listeners.splice(idx, 1);
    };
  }
}
