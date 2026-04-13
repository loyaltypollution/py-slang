import type { Lattice } from "./lattice";
import type { Db } from "./db";

export interface QueryHandle<Args, V> {
  readonly id: symbol;
  readonly name: string;
  readonly lattice: Lattice<V>;
  readonly serialize: (args: Args) => string;
  readonly fn: (db: Db, args: Args) => V;
  readonly isCyclic: boolean;
}

export function defineQuery<Args, V>(opts: {
  name: string;
  lattice: Lattice<V>;
  serialize: (args: Args) => string;
  fn: (db: Db, args: Args) => V;
  isCyclic?: boolean;
}): QueryHandle<Args, V> {
  return {
    id: Symbol(opts.name),
    name: opts.name,
    lattice: opts.lattice,
    serialize: opts.serialize,
    fn: opts.fn,
    isCyclic: opts.isCyclic ?? false,
  };
}
