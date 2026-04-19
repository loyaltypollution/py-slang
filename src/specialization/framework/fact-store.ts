import type { Analysis } from "./analysis";
import { ROOT_CONTEXT, type Context } from "./context";

/** Fired on value-changing writes. `oldValue` is `undefined` if the cell was
 *  empty. `context` identifies the speculation-assumption chain the cell
 *  lives under; ROOT_CONTEXT = no assumptions. */
export interface FactChange<K, V> {
  readonly analysis: Analysis<K, V>;
  readonly key: K;
  readonly context: Context;
  readonly oldValue: V | undefined;
  readonly newValue: V;
}

type FactChangeListener = (change: FactChange<unknown, unknown>) => void;

/** Fact storage keyed by `(analysis, key, context)`. Writes combine via the
 *  analysis-declared storage merge `join(prev, value)`, never `value` alone.
 *  A write where that actual combine is equal to `prev` returns `false` and
 *  skips listener fan-out.
 *
 *  We intentionally compare the computed `joined` result against `prev`
 *  instead of using a generic `leq(value, prev)` fast path. That shortcut is
 *  valid only when `join` is the least-upper-bound for the same order exposed
 *  by `leq`; some analyses (notably must-style DFA block facts) reuse the
 *  `Lattice<V>` surface for a different storage-combine discipline, where a
 *  "smaller" incoming value must still advance the cell. Equality on the
 *  real combined value is correct for both regimes.
 *
 *  Context dimension: each (analysis, key) can hold independent cells under
 *  different `Context`s. Cells at different contexts do not merge. A read at
 *  a context that has no cell returns the lattice bottom — NOT the cell at
 *  the parent context. Seeding a child context from its parent's facts is a
 *  caller-level policy (sound over-approximation), not a FactStore default,
 *  because the engine may want fresh-start seeding for speculation.
 *
 *  All API methods accept an optional `context` argument defaulting to
 *  ROOT_CONTEXT, so existing callers that predate the context dimension
 *  operate on the ROOT cell and are unaffected. */
export class FactStore {
  private readonly cells = new Map<
    Analysis<unknown, unknown>,
    Map<Context, Map<unknown, unknown>>
  >();
  private readonly listeners: FactChangeListener[] = [];

  private cellsFor<K, V>(
    analysis: Analysis<K, V>,
    context: Context,
  ): Map<unknown, unknown> | undefined {
    return this.cells
      .get(analysis as Analysis<unknown, unknown>)
      ?.get(context);
  }

  read<K, V>(analysis: Analysis<K, V>, key: K, context: Context = ROOT_CONTEXT): V {
    const inner = this.cellsFor(analysis, context);
    if (inner === undefined || !inner.has(key)) return analysis.lattice.bottom;
    return inner.get(key) as V;
  }

  tryRead<K, V>(analysis: Analysis<K, V>, key: K, context: Context = ROOT_CONTEXT): V | undefined {
    const inner = this.cellsFor(analysis, context);
    if (inner === undefined || !inner.has(key)) return undefined;
    return inner.get(key) as V;
  }

  readAll<K, V>(analysis: Analysis<K, V>, context: Context = ROOT_CONTEXT): ReadonlyMap<K, V> {
    const inner = this.cellsFor(analysis, context);
    return (inner ?? new Map()) as ReadonlyMap<K, V>;
  }

  /** Write a fact. The stored value is `join(prev, value)`; a write that does
   *  not advance the lattice is a no-op. Returns `true` iff the cell advanced
   *  and a listener event fired. */
  write<K, V>(
    analysis: Analysis<K, V>,
    key: K,
    value: V,
    context: Context = ROOT_CONTEXT,
  ): boolean {
    const analysisKey = analysis as Analysis<unknown, unknown>;
    let byContext = this.cells.get(analysisKey);
    if (byContext === undefined) {
      byContext = new Map();
      this.cells.set(analysisKey, byContext);
    }
    let inner = byContext.get(context);
    if (inner === undefined) {
      inner = new Map();
      byContext.set(context, inner);
    }

    const hadPrev = inner.has(key);
    const prev = hadPrev ? (inner.get(key) as V) : undefined;
    const joined = hadPrev ? analysis.lattice.join(prev as V, value) : value;
    if (hadPrev && analysis.lattice.eq(joined, prev as V)) return false;

    inner.set(key, joined);
    const change: FactChange<K, V> = {
      analysis,
      key,
      context,
      oldValue: prev,
      newValue: joined,
    };
    for (const l of this.listeners) l(change as FactChange<unknown, unknown>);
    return true;
  }

  /** Delete a cell. Silent if absent; no event emitted. */
  evict<K, V>(analysis: Analysis<K, V>, key: K, context: Context = ROOT_CONTEXT): void {
    this.cellsFor(analysis, context)?.delete(key);
  }

  onChange(listener: FactChangeListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx !== -1) this.listeners.splice(idx, 1);
    };
  }
}
