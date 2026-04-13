export interface Lattice<V> {
  readonly bottom: V;
  equals(a: V, b: V): boolean;
  join(a: V, b: V): V;
}
