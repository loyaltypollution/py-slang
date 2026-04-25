import type { Worklist } from "../framework/worklist";

export class CounterStore<K> {
  private readonly counts = new Map<K, number>();

  constructor(readonly saturation: number) {
    if (!Number.isInteger(saturation) || saturation <= 0) {
      throw new Error(
        `[CounterStore] saturation must be a positive integer, got ${saturation}`,
      );
    }
  }

  at(key: K): number {
    return this.counts.get(key) ?? 0;
  }

  bind?(worklist: Worklist): void;

  _applyBump(key: K): { prev: number; next: number } | null {
    const prev = this.counts.get(key) ?? 0;
    if (prev >= this.saturation) return null;
    const next = prev + 1;
    this.counts.set(key, next);
    return { prev, next };
  }
}
