import type { Pass } from "./pass";

/**
 * Event emitted when a fact-store write changes a `(pass, key)` cell's
 * value under `pass.lattice.equals`. Equality-identical writes produce no
 * event — this is the single mechanism that collapses the old
 * `markDirty`/`flushDirty`/`subscribers` triad into one primitive.
 *
 * `oldValue` is the pre-write value; `null` if the cell was previously
 * empty. `newValue` is always a defined value — `undefined` returns from a
 * pass's `transfer` never reach the store.
 */
export interface FactChange<K, V> {
  readonly pass: Pass<K, V>;
  readonly key: K;
  readonly oldValue: V | null;
  readonly newValue: V;
}

export type FactChangeListener = (change: FactChange<unknown, unknown>) => void;

/**
 * Single source of truth for pass-produced facts. Keyed by `(pass, key)`
 * using a two-level map (outer keyed by pass identity, inner by the pass's
 * own `K`). Writes are equality-gated: if the incoming value compares equal
 * to the stored one under `pass.lattice.equals`, the write is a no-op and
 * no listener fires. This is what makes saturating lattices (e.g. the
 * `callCountPass` bucket) suppress downstream work once they converge.
 */
export class FactStore {
  private readonly cells = new Map<Pass<unknown, unknown>, Map<unknown, unknown>>();
  private readonly listeners = new Set<FactChangeListener>();

  read<K, V>(pass: Pass<K, V>, key: K): V {
    const inner = this.cells.get(pass as Pass<unknown, unknown>);
    if (inner === undefined) return pass.lattice.bottom;
    if (!inner.has(key)) return pass.lattice.bottom;
    return inner.get(key) as V;
  }

  tryRead<K, V>(pass: Pass<K, V>, key: K): V | undefined {
    const inner = this.cells.get(pass as Pass<unknown, unknown>);
    if (inner === undefined || !inner.has(key)) return undefined;
    return inner.get(key) as V;
  }

  has<K, V>(pass: Pass<K, V>, key: K): boolean {
    return this.cells.get(pass as Pass<unknown, unknown>)?.has(key) ?? false;
  }

  readAll<K, V>(pass: Pass<K, V>): ReadonlyMap<K, V> {
    const inner = this.cells.get(pass as Pass<unknown, unknown>);
    return (inner ?? new Map()) as ReadonlyMap<K, V>;
  }

  /**
   * Write a fact. Returns `true` iff the value changed under the pass's
   * lattice equality and a listener event was fired.
   */
  write<K, V>(pass: Pass<K, V>, key: K, value: V): boolean {
    let inner = this.cells.get(pass as Pass<unknown, unknown>);
    if (inner === undefined) {
      inner = new Map();
      this.cells.set(pass as Pass<unknown, unknown>, inner);
    }

    const hadPrev = inner.has(key);
    const prev = hadPrev ? (inner.get(key) as V) : null;

    if (hadPrev && pass.lattice.equals(prev as V, value)) return false;

    inner.set(key, value);
    const change: FactChange<K, V> = {
      pass,
      key,
      oldValue: prev,
      newValue: value,
    };
    for (const listener of this.listeners) {
      listener(change as FactChange<unknown, unknown>);
    }
    return true;
  }

  /** Delete a `(pass, key)` cell. Silent if absent. Does not emit events. */
  evict<K, V>(pass: Pass<K, V>, key: K): void {
    this.cells.get(pass as Pass<unknown, unknown>)?.delete(key);
  }

  onChange(listener: FactChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
