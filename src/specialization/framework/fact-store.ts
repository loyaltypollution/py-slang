import type { Pass } from "./pass";

/** Fired on value-changing `(pass, key)` writes. `oldValue` is `undefined` if the cell was empty. */
export interface FactChange<K, V> {
  readonly pass: Pass<K, V>;
  readonly key: K;
  readonly oldValue: V | undefined;
  readonly newValue: V;
}

type FactChangeListener = (change: FactChange<unknown, unknown>) => void;

/** Fact storage keyed by `(pass, key)`. Writes are lattice-monotone: the stored
 *  cell is `join(prev, value)`, never `value` alone. A write that produces no
 *  change under `lattice.equals` suppresses listener fan-out. This turns the
 *  lattice's monotonicity promise into a framework-level invariant — callers
 *  can pass raw transfer output without hand-joining, and regressive writes
 *  (value ⊏ prev) collapse to no-ops instead of silently corrupting state. */
export class FactStore {
  private readonly cells = new Map<Pass<unknown, unknown>, Map<unknown, unknown>>();
  private readonly listeners = new Set<FactChangeListener>();

  read<K, V>(pass: Pass<K, V>, key: K): V {
    const inner = this.cells.get(pass as Pass<unknown, unknown>);
    if (inner === undefined || !inner.has(key)) return pass.lattice.bottom;
    return inner.get(key) as V;
  }

  tryRead<K, V>(pass: Pass<K, V>, key: K): V | undefined {
    const inner = this.cells.get(pass as Pass<unknown, unknown>);
    if (inner === undefined || !inner.has(key)) return undefined;
    return inner.get(key) as V;
  }

  readAll<K, V>(pass: Pass<K, V>): ReadonlyMap<K, V> {
    const inner = this.cells.get(pass as Pass<unknown, unknown>);
    return (inner ?? new Map()) as ReadonlyMap<K, V>;
  }

  /** Write a fact. The stored value is `join(prev, value)`; a write that does
   *  not advance the lattice is a no-op. Returns `true` iff the cell advanced
   *  and a listener event fired. */
  write<K, V>(pass: Pass<K, V>, key: K, value: V): boolean {
    let inner = this.cells.get(pass as Pass<unknown, unknown>);
    if (inner === undefined) {
      inner = new Map();
      this.cells.set(pass as Pass<unknown, unknown>, inner);
    }

    const hadPrev = inner.has(key);
    const prev = hadPrev ? (inner.get(key) as V) : undefined;
    const joined = hadPrev ? pass.lattice.join(prev as V, value) : value;

    if (hadPrev && pass.lattice.equals(prev as V, joined)) return false;

    inner.set(key, joined);
    const change: FactChange<K, V> = {
      pass,
      key,
      oldValue: prev,
      newValue: joined,
    };
    for (const listener of this.listeners) {
      listener(change as FactChange<unknown, unknown>);
    }
    return true;
  }

  /** Delete a cell. Silent if absent; no event emitted. */
  evict<K, V>(pass: Pass<K, V>, key: K): void {
    this.cells.get(pass as Pass<unknown, unknown>)?.delete(key);
  }

  onChange(listener: FactChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
