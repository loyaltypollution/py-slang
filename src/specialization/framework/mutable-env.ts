/** Per-function slot → L env. Slot numbering matches SVMLCompiler. */
export class MutableEnv<L> {
  private slots: (L | undefined)[];

  constructor(initial: (L | undefined)[] = []) {
    this.slots = initial.slice();
  }

  get(slot: number): L | undefined {
    return this.slots[slot];
  }

  set(slot: number, val: L): void {
    this.slots[slot] = val;
  }

  snapshot(): MutableEnv<L> {
    return new MutableEnv(this.slots);
  }

  /** In-place join; missing slots treated as ⊥. */
  joinWith(other: MutableEnv<L>, joinFn: (a: L, b: L) => L): void {
    const len = Math.max(this.slots.length, other.slots.length);
    for (let i = 0; i < len; i++) {
      const a = this.slots[i];
      const b = other.slots[i];
      if (a !== undefined && b !== undefined) {
        this.slots[i] = joinFn(a, b);
      } else {
        this.slots[i] = a ?? b;
      }
    }
  }

  /** In-place meet; missing slots treated as ⊤. */
  meetWith(other: MutableEnv<L>, meetFn: (a: L, b: L) => L, top: L): void {
    const len = Math.max(this.slots.length, other.slots.length);
    for (let i = 0; i < len; i++) {
      const a = this.slots[i];
      const b = other.slots[i];
      if (a !== undefined && b !== undefined) {
        this.slots[i] = meetFn(a, b);
      } else if (a !== undefined) {
        this.slots[i] = meetFn(a, top);
      } else if (b !== undefined) {
        this.slots[i] = meetFn(top, b);
      }
    }
  }

  equals(other: MutableEnv<L>, leq: (a: L, b: L) => boolean): boolean {
    if (this.slots.length !== other.slots.length) return false;
    for (let i = 0; i < this.slots.length; i++) {
      const a = this.slots[i];
      const b = other.slots[i];
      if (a === b) continue;
      if (a === undefined || b === undefined) return false;
      if (!leq(a, b) || !leq(b, a)) return false;
    }
    return true;
  }
}
