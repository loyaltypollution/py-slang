export class SaturatingCounter<K> {
  private readonly counts = new Map<K, number>();

  constructor(readonly max: number) {}

  at(key: K): number {
    return this.counts.get(key) ?? 0;
  }

  increment(key: K): boolean {
    const current = this.counts.get(key) ?? 0;
    if (current >= this.max) return false;
    this.counts.set(key, current + 1);
    return true;
  }
}
