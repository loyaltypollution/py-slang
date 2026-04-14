import { latticeEquals, type BoundedLattice, type Lattice } from "./pass";

/** Per-function slot → L env. Slot numbering matches SVMLCompiler. */
export class MutableEnv<L> {
  private slots: (L | undefined)[];
  /** Once frozen, every mutator throws. Used by DFA factories that publish a
   *  shared ⊥ singleton: callers must `snapshot()` before any mutation.
   *  Forgetting the snapshot used to silently corrupt every unwritten read
   *  through the pass's bottom fact; now it throws at the first offending
   *  write. Frozen flag is copied-false by `snapshot` — the copy is a private,
   *  mutable working env for the caller. */
  private frozen = false;

  constructor(initial: (L | undefined)[] = []) {
    this.slots = initial.slice();
  }

  get(slot: number): L | undefined {
    return this.slots[slot];
  }

  set(slot: number, val: L): void {
    this.assertMutable();
    this.slots[slot] = val;
  }

  snapshot(): MutableEnv<L> {
    return new MutableEnv(this.slots);
  }

  /** Seal this env. Callers that publish an env as shared read-only state
   *  (e.g. the DFA bottomFact singleton) must call this; any accidental
   *  mutation via `set`/`joinWith`/`meetWith` will throw. */
  freeze(): this {
    this.frozen = true;
    return this;
  }

  private assertMutable(): void {
    if (this.frozen) {
      throw new Error(
        "[MutableEnv] mutation of frozen env — call snapshot() before mutating a shared bottom/fact env",
      );
    }
  }

  /** In-place join; missing slots treated as ⊥. */
  joinWith(other: MutableEnv<L>, lattice: Lattice<L>): void {
    this.assertMutable();
    const len = Math.max(this.slots.length, other.slots.length);
    for (let i = 0; i < len; i++) {
      const a = this.slots[i];
      const b = other.slots[i];
      if (a !== undefined && b !== undefined) {
        this.slots[i] = lattice.join(a, b);
      } else {
        this.slots[i] = a ?? b;
      }
    }
  }

  /** In-place meet; missing slots treated as ⊤. */
  meetWith(other: MutableEnv<L>, lattice: BoundedLattice<L>): void {
    this.assertMutable();
    const len = Math.max(this.slots.length, other.slots.length);
    for (let i = 0; i < len; i++) {
      const a = this.slots[i];
      const b = other.slots[i];
      if (a !== undefined && b !== undefined) {
        this.slots[i] = lattice.meet(a, b);
      } else if (a !== undefined) {
        this.slots[i] = lattice.meet(a, lattice.top);
      } else if (b !== undefined) {
        this.slots[i] = lattice.meet(lattice.top, b);
      }
    }
  }

  equals(other: MutableEnv<L>, lattice: Lattice<L>): boolean {
    if (this.slots.length !== other.slots.length) return false;
    for (let i = 0; i < this.slots.length; i++) {
      const a = this.slots[i];
      const b = other.slots[i];
      if (a === b) continue;
      if (a === undefined || b === undefined) return false;
      if (!latticeEquals(lattice, a, b)) return false;
    }
    return true;
  }
}
