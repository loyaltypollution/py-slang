import type { Narrowing } from "../../../specialization/framework/analysis";

export function makeNarrowing<K, V>(eq: (a: V, b: V) => boolean = Object.is): Narrowing<K, V> {
  return {
    eq,
    blockAnalysis: () => ({} as any),
    lift: () => undefined,
  };
}

export interface Boxed {
  readonly v: number;
}

export const box = (v: number): Boxed => ({ v });
export const boxedEq = (a: Boxed, b: Boxed): boolean => a === b || a.v === b.v;
