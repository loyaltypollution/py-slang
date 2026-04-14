import { latticeEquals, type Pass } from "./pass";

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
 *  change under `latticeEquals` suppresses listener fan-out. This turns the
 *  lattice's monotonicity promise into a framework-level invariant — callers
 *  can pass raw transfer output without hand-joining, and regressive writes
 *  (value ⊏ prev) collapse to no-ops instead of silently corrupting state. */
export class FactStore {
  private readonly cells = new Map<Pass<unknown, unknown>, Map<unknown, unknown>>();
  private readonly listeners: FactChangeListener[] = [];
  /** True while iterating `listeners` inside `write`. Re-entrant writes
   *  would append events mid-dispatch and produce ordering hazards; the
   *  comment-only "no reentry" contract became load-bearing documentation
   *  that no runtime check enforced, so we restore the loud failure. */
  private inWrite = false;

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
    // Fast path: if `value ⊑ prev`, the join is `prev` and no cell advance can
    // happen. Skips allocating a join result for the common monotone-no-op
    // case (e.g. re-transfer producing the same fact). Correct under the
    // lattice contract: `leq(v, prev) ⇒ join(prev, v) = prev`.
    if (hadPrev && pass.lattice.leq(value, prev as V)) return false;
    const joined = hadPrev ? pass.lattice.join(prev as V, value) : value;

    if (hadPrev && latticeEquals(pass.lattice, prev as V, joined)) return false;

    inner.set(key, joined);
    const change: FactChange<K, V> = {
      pass,
      key,
      oldValue: prev,
      newValue: joined,
    };
    if (this.inWrite) {
      throw new Error(
        `[FactStore] reentrant write during listener dispatch (pass=${pass.debugName}). Listeners MUST NOT call factStore.write — schedule work via worklist.enqueue instead.`,
      );
    }
    this.inWrite = true;
    try {
      for (const l of this.listeners) l(change as FactChange<unknown, unknown>);
    } finally {
      this.inWrite = false;
    }
    return true;
  }

  /** Delete a cell. Silent if absent; no event emitted. */
  evict<K, V>(pass: Pass<K, V>, key: K): void {
    this.cells.get(pass as Pass<unknown, unknown>)?.delete(key);
  }

  onChange(listener: FactChangeListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx !== -1) this.listeners.splice(idx, 1);
    };
  }
}
