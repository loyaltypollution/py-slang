import type { Worklist } from "../framework/worklist";

export class CounterStore<K> {
  private readonly counts = new Map<K, number>();

  constructor(readonly saturation: number) {}

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
