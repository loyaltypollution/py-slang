import type { NarrowingAxis } from "../../../specialization/assumption/chain";

export function makeNarrowing<K, V>(eq: (a: V, b: V) => boolean = Object.is): NarrowingAxis<K, V> {
  return { eq };
}

export interface Boxed {
  readonly v: number;
}

export const box = (v: number): Boxed => ({ v });
export const boxedEq = (a: Boxed, b: Boxed): boolean => a === b || a.v === b.v;
