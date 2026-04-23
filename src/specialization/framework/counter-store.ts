// Key → saturating count. A profiler/evidence surface distinct from
// `Analysis`: no transfer, no lattice, no context — just an opaque counter
// that the worklist bumps and fans out to subscribers.
//
// Dispatch: `Worklist.bump(counter, key)` advances the count (clamped at
// `saturation`) and fires subscribers. Post-saturation bumps are no-ops.

import type { Worklist } from "./worklist";

export interface CounterSpec {
  /** Inclusive ceiling. Reaching this value freezes the cell. */
  readonly saturation: number;
}

export class CounterStore<K> implements CounterSpec {
  readonly saturation: number;
  private readonly counts = new Map<K, number>();

  constructor(spec: CounterSpec) {
    if (!Number.isInteger(spec.saturation) || spec.saturation <= 0) {
      throw new Error(
        `[CounterStore] saturation must be a positive integer, got ${spec.saturation}`,
      );
    }
    this.saturation = spec.saturation;
  }

  /** Current count at `key`. Unwritten keys read as 0. */
  at(key: K): number {
    return this.counts.get(key) ?? 0;
  }

  /** Drop the cell at `key`. Idempotent. */
  evict(key: K): void {
    this.counts.delete(key);
  }

  /** Optional registration hook. Called by `Worklist.registerCounter`. */
  bind?(worklist: Worklist): void;

  /** Package-private. Called only by `Worklist.bump`. Returns the prev/next
   *  pair when the cell advanced, or `null` when already saturated. */
  _applyBump(key: K): { prev: number; next: number } | null {
    const prev = this.counts.get(key) ?? 0;
    if (prev >= this.saturation) return null;
    const next = prev + 1;
    this.counts.set(key, next);
    return { prev, next };
  }
}

export function defineCounterStore<K>(
  spec: CounterSpec & { bind?: (this: CounterStore<K>, worklist: Worklist) => void },
): CounterStore<K> {
  const c = new CounterStore<K>(spec);
  if (spec.bind !== undefined) c.bind = spec.bind.bind(c);
  return c;
}
