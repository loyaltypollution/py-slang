import type { FunctionUnit } from "./function-unit";
import type { StmtNS } from "../../ast-types";
import type { FactStore } from "./fact-store";

/**
 * Algebraic structure a `Pass`'s value space must satisfy. `equals` gates
 * whether a write produces a change event; `join` is used by DFA-style
 * fixpoints (and by the framework to merge concurrent writes to the same
 * key, should that ever happen — today writes are single-producer). `bottom`
 * is the value returned by `PassCtx.read` when no fact has been written yet.
 *
 * Some lattices are top-only (e.g. fireOnce rules whose value is just
 * `"fired"`): `bottom` = `undefined`-shaped sentinel, `join` = right-biased,
 * `equals` = strict equality. `leq` is not required by the framework.
 */
export interface Lattice<V> {
  readonly bottom: V;
  equals(a: V, b: V): boolean;
  join(a: V, b: V): V;
}

/**
 * A unit of computation over the fact store. Each pass declares its key and
 * value types, the other passes it reads from, and a transfer function that
 * produces a new value for a given key.
 *
 * Granularity (node vs block vs scope vs unit) is encoded in `K` — the
 * framework does not distinguish "analysis" from "scope pass" from "transform
 * rule" structurally. Their only difference is the shape of `K` and `V` and
 * what `transfer` does.
 *
 * `reads` is a read-set, not a call list: the framework enqueues this pass
 * when any pass in `reads` produces a lattice-change. `affectedKeys` maps a
 * trigger (read-pass, read-key) to the subset of this pass's keys that need
 * re-transfer; passes that cannot supply a precise mapping must set
 * `coarse: true` to opt in to "re-run on all previously written keys".
 *
 * `transfer` returning `undefined` means "no write for this key" — distinct
 * from writing `lattice.bottom`, which is an explicit reset.
 *
 * Side effects in `transfer` (e.g. JIT patchFunction) must be idempotent
 * under `lattice.equals`: if the produced value equals the current one, the
 * side effect must be a no-op, so spurious re-transfers on already-converged
 * facts do not cause observable behavior changes.
 */
export interface Pass<K, V> {
  readonly id: symbol;
  readonly debugName: string;
  readonly lattice: Lattice<V>;
  readonly reads: ReadonlyArray<Pass<any, any>>;
  /** Drain-order tier tiebreaker. See worklist drain policy. */
  readonly tier?: "runtime" | "analysis" | "transform" | "jit";
  readonly coarse?: boolean;
  transfer(ctx: PassCtx, key: K): V | undefined;
  affectedKeys?(
    ctx: PassCtx,
    triggerPass: Pass<any, any>,
    triggerKey: unknown,
  ): Iterable<K>;
  /**
   * Called when this pass's keyspace must shrink — e.g. on CFG rebuild,
   * BlockId keys of the old CFG are no longer meaningful. Receives the keys
   * this pass has previously written (sourced from the fact store) so the
   * pass does not maintain a shadow tracker. Returns keys to evict.
   */
  prune?(ctx: PassCtx, unit: FunctionUnit, previousKeys: Iterable<K>): Iterable<K>;
}

/**
 * View handed to `Pass.transfer`. Reads are unchecked at the type level in
 * this PR — `ctx.read(p, k)` returns the current fact or `p.lattice.bottom`
 * if never written. A follow-up PR (`framework-typed-reads`) will promote
 * `reads` to a tuple so read-keys are type-checked per declared read.
 */
export interface PassCtx {
  read<K2, V2>(p: Pass<K2, V2>, key: K2): V2;
  readAll<K2, V2>(p: Pass<K2, V2>): ReadonlyMap<K2, V2>;
  unitFor(scope: StmtNS.FileInput | StmtNS.FunctionDef): FunctionUnit | undefined;
  /** Direct fact-store handle for accessor-mediated reads/writes from transforms. */
  readonly factStore: FactStore;
}
