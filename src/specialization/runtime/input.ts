import type { Lattice } from "./lattice";
import type { Db } from "./db";
import { QueryHandle } from "./query";

export interface InputHandle<K, V> {
  readonly id: symbol;
  readonly name: string;
  readonly lattice: Lattice<V>;
  readonly serialize: (key: K) => string;
  readonly reader: QueryHandle<K, V>;
  set(db: Db, key: K, value: V): void;
  get(db: Db, key: K): V;
}

export function defineInput<K, V>(
  name: string,
  lattice: Lattice<V>,
  serialize: (key: K) => string,
): InputHandle<K, V> {
  const id = Symbol(name);

  const reader: QueryHandle<K, V> = {
    id,
    name,
    lattice,
    serialize,
    fn: (db, key) => db.readRaw<V>(db.cellIdFor({ id, serialize }, key), lattice.bottom),
    isCyclic: false,
  };

  return {
    id,
    name,
    lattice,
    serialize,
    reader,
    set(db, key, value) {
      db.writeInput<K, V>(this, key, value);
    },
    get(db, key) {
      return db.get(reader, key);
    },
  };
}
