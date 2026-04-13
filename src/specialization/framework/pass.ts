import type { FunctionUnit } from "./function-unit";
import type { StmtNS } from "../../ast-types";
import type { FactStore } from "./fact-store";

/**
 * Algebraic structure a `Pass`'s value space must satisfy. `equals` gates
 * change-event emission on write; `join` merges concurrent writes (today
 * writes are single-producer, so this is mainly for DFA-style fixpoints);
 * `bottom` is what `PassCtx.read` returns for an unwritten cell.
 */
export interface Lattice<V> {
  readonly bottom: V;
  equals(a: V, b: V): boolean;
  join(a: V, b: V): V;
}

/**
 * A unit of computation over the fact store. Granularity (node/block/scope/
 * unit) is encoded entirely in `K` — analyses, scope passes, and transforms
 * differ only in `K`, `V`, and what `transfer` does.
 *
 * `reads` is a read-set: the framework enqueues this pass on any
 * lattice-change in a read pass. `affectedKeys` narrows the trigger to a
 * subset of this pass's keys; passes without a precise mapping must set
 * `coarse: true` (re-run on all previously written keys).
 *
 * `transfer` returning `undefined` means "no write" (distinct from writing
 * `lattice.bottom`, which is an explicit reset). Side effects in `transfer`
 * must be idempotent under `lattice.equals` so spurious re-transfers on
 * already-converged facts are observable no-ops.
 */
export interface Pass<K, V> {
  readonly id: symbol;
  readonly debugName: string;
  readonly lattice: Lattice<V>;
  readonly reads: ReadonlyArray<Pass<any, any>>;
  /** Drain-order tier tiebreaker. See worklist drain policy. */
  readonly tier?: "runtime" | "analysis" | "transform";
  readonly coarse?: boolean;
  transfer(ctx: PassCtx, key: K): V | undefined;
  affectedKeys?(
    ctx: PassCtx,
    triggerPass: Pass<any, any>,
    triggerKey: unknown,
  ): Iterable<K>;
  /**
   * Called when this pass's keyspace must shrink — e.g. on CFG rebuild,
   * BlockId keys of the old CFG are no longer meaningful.
   *
   * **Contract:** `previousKeys` is the full keyset this pass has
   * written across *all* units, not just the rebuilt one. The
   * implementation must filter to keys belonging to `unit` (typically
   * `k.unit === unit` for block keys, `k === unit` for unit keys, or
   * `ctx.unitForNode(k) === unit` for node keys). Returning a key from
   * another unit would incorrectly evict it. Returns the subset to evict.
   */
  prune?(ctx: PassCtx, unit: FunctionUnit, previousKeys: Iterable<K>): Iterable<K>;
}

/** View handed to `Pass.transfer`. Reads are unchecked at the type level. */
export interface PassCtx {
  /** Current fact, or the pass's lattice `bottom` if no cell exists. */
  read<K2, V2>(p: Pass<K2, V2>, key: K2): V2;
  /** Current fact, or `undefined` if no cell exists (distinguishes "unset"
   *  from "set to bottom"). */
  tryRead<K2, V2>(p: Pass<K2, V2>, key: K2): V2 | undefined;
  readAll<K2, V2>(p: Pass<K2, V2>): ReadonlyMap<K2, V2>;
  unitFor(funcAst: StmtNS.FileInput | StmtNS.FunctionDef): FunctionUnit | undefined;
  /** Resolve the `FunctionUnit` containing a node by its numeric id. Pure
   *  structural lookup — does not depend on fact-store state. */
  unitForNode(nodeId: number): FunctionUnit | undefined;
  /** Resolve the `FunctionUnit` whose `funcAst` is a `FunctionDef` with the
   *  given id. O(1); returns undefined for the module unit or unknown ids. */
  unitForFdId(fdId: number): FunctionUnit | undefined;
  /**
   * Direct fact-store handle. **Internal use only** — reserved for the
   * DFA factory's `transferBlock`, which must write to its own pass's
   * cells during block-level fixpoint. All other consumers must use
   * `ctx.read` / `ctx.tryRead` / `ctx.readAll` and let the framework
   * route writes through `transfer`'s return value.
   */
  readonly factStore: FactStore;
}
