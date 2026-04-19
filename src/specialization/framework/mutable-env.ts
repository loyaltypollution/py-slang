import type { Lattice, JoinSemiLattice } from "./analysis";

/** Lifted per-function slot-map domain over a value lattice `L`.
 *
 *  Shape: partial map `slot -> L`, where slot numbering matches the
 *  SVMLCompiler's frame layout. Missing slots are meaningful: `joinWith` /
 *  `leq` treat absence as the join-side default, while `meetWith` treats an
 *  absent binding on one side as `top` on that side. This is why `MutableEnv`
 *  is more than a mutable helper — it encodes part of the block-analysis
 *  algebra stored in the paired `.env` cell produced by
 *  `makeBlockFixpointAnalysis`.
 */
export class MutableEnv<L> {
  private slots: (L | undefined)[];
  /** Once frozen, every mutator throws. Used by DFA factories that publish a
   *  shared ⊥ singleton: callers must `snapshot()` before any mutation.
   *  Forgetting the snapshot used to silently corrupt every unwritten read
   *  through the analysis's bottom fact; now it throws at the first offending
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

  /** Remove a slot binding. Present for analyses (liveness) whose "bottom"
   *  is represented by absence rather than a sentinel value — a kill-then-gen
   *  cycle in the transfer needs to distinguish "never written here" from
   *  "written with bottom." */
  clear(slot: number): void {
    this.assertMutable();
    this.slots[slot] = undefined;
  }

  /** Iterate slot ids whose bindings are defined (non-undefined). */
  *definedSlots(): IterableIterator<number> {
    for (let i = 0; i < this.slots.length; i++) {
      if (this.slots[i] !== undefined) yield i;
    }
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

  /** In-place pointwise join on the lifted slot-map domain; missing slots are
   *  treated as the join-side default (conceptually ⊥ for may-style merge). */
  joinWith(other: MutableEnv<L>, lattice: JoinSemiLattice<L>): void {
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

  /** In-place pointwise meet on the lifted slot-map domain; missing slots are
   *  treated as ⊤ on the side where the binding is absent. */
  meetWith(other: MutableEnv<L>, lattice: Lattice<L>): void {
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

  /** Pointwise order on the lifted slot-map domain under `lattice.leq`.
   *  Missing slots are treated as the left-side default: `undefined` on the
   *  left is trivially ≤ anything, and on the right only if the left is also
   *  `undefined`. Callers must supply the same lattice they use for
   *  `join`/`meet` — inconsistent lattices would make the order disagree with
   *  the combine-induced one. */
  leq(other: MutableEnv<L>, lattice: JoinSemiLattice<L>): boolean {
    const len = Math.max(this.slots.length, other.slots.length);
    for (let i = 0; i < len; i++) {
      const a = this.slots[i];
      if (a === undefined) continue;
      const b = other.slots[i];
      if (b === undefined) return false;
      if (!lattice.leq(a, b)) return false;
    }
    return true;
  }
}
