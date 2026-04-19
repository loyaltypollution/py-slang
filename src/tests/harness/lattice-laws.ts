import type { BoundedLattice, Lattice } from "../../specialization/framework/analysis";

interface LatticeLawOptions<V> {
  readonly values: ReadonlyArray<V>;
  readonly describeValue?: (value: V) => string;
}

function valueLabel<V>(value: V, describeValue?: (value: V) => string): string {
  if (describeValue !== undefined) return describeValue(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function dedupeByEq<V>(values: ReadonlyArray<V>, eq: (a: V, b: V) => boolean): V[] {
  const out: V[] = [];
  outer: for (const value of values) {
    for (const existing of out) {
      if (eq(existing, value)) continue outer;
    }
    out.push(value);
  }
  return out;
}

export function expectLatticeLaws<V>(
  lattice: Lattice<V>,
  { values, describeValue }: LatticeLawOptions<V>,
): void {
  const elems = dedupeByEq([lattice.bottom, ...values], lattice.eq);

  for (const a of elems) {
    expect(lattice.leq(a, a)).toBe(true);
    expect(lattice.eq(a, a)).toBe(true);
    expect(lattice.eq(lattice.join(a, a), a)).toBe(true);
  }

  for (const a of elems) {
    for (const b of elems) {
      const ab = lattice.join(a, b);
      const ba = lattice.join(b, a);
      expect(lattice.eq(ab, ba)).toBe(true);
      expect(lattice.leq(a, ab)).toBe(true);
      expect(lattice.leq(b, ab)).toBe(true);
      expect(lattice.eq(lattice.join(ab, b), ab)).toBe(true);

      const expectedEq = lattice.leq(a, b) && lattice.leq(b, a);
      expect(lattice.eq(a, b)).toBe(expectedEq);
      expect(lattice.eq(ab, b)).toBe(lattice.leq(a, b));
      expect(lattice.eq(ab, a)).toBe(lattice.leq(b, a));

      if (describeValue !== undefined) {
        expect(valueLabel(a, describeValue)).not.toHaveLength(0);
        expect(valueLabel(b, describeValue)).not.toHaveLength(0);
      }
    }
  }
}

export function expectBoundedLatticeLaws<V>(
  lattice: BoundedLattice<V>,
  { values, describeValue }: LatticeLawOptions<V>,
): void {
  const elems = dedupeByEq([lattice.bottom, lattice.top, ...values], lattice.eq);
  expectLatticeLaws(lattice, { values: elems, describeValue });

  for (const a of elems) {
    expect(lattice.leq(lattice.bottom, a)).toBe(true);
    expect(lattice.leq(a, lattice.top)).toBe(true);
    expect(lattice.eq(lattice.meet(a, a), a)).toBe(true);
  }

  for (const a of elems) {
    for (const b of elems) {
      const ab = lattice.meet(a, b);
      const ba = lattice.meet(b, a);
      expect(lattice.eq(ab, ba)).toBe(true);
      expect(lattice.leq(ab, a)).toBe(true);
      expect(lattice.leq(ab, b)).toBe(true);
      expect(lattice.eq(lattice.meet(ab, b), ab)).toBe(true);
      expect(lattice.eq(ab, a)).toBe(lattice.leq(a, b));
      expect(lattice.eq(ab, b)).toBe(lattice.leq(b, a));

    }
  }
}
