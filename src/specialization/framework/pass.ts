import type { FunctionUnit } from "./function-unit";
import type { FactStore } from "./fact-store";

/** Value-space algebra. `leq` is the partial order (a ⊑ b). `join` is the
 *  least upper bound. `bottom` is returned for unwritten cells. Equality is
 *  always derived as `leq(a,b) && leq(b,a)` — no custom override, so the
 *  partial order is the single source of truth for change detection. */
export interface Lattice<V> {
  readonly bottom: V;
  leq(a: V, b: V): boolean;
  join(a: V, b: V): V;
}

/** Equality under the lattice's partial order, derived from `leq`. */
export function latticeEquals<V>(lattice: Lattice<V>, a: V, b: V): boolean {
  return lattice.leq(a, b) && lattice.leq(b, a);
}

/** Bounded lattice: adds `top` and `meet` to `Lattice<V>`. Required by DFA
 *  value-lattices — `meet` is the dual merge for "must" analyses, and `top`
 *  seeds MutableEnv slots when the generic block transfer widens (e.g. For
 *  loop targets). Cell-level `Lattice<V>` (the `Pass.lattice` type) does not
 *  need these; counters, sticky flags, and observation lattices rarely have
 *  a natural `top` or `meet`, so we keep the base interface permissive. */
export interface BoundedLattice<V> extends Lattice<V> {
  readonly top: V;
  meet(a: V, b: V): V;
}

/** An edge to an upstream pass. `wake` projects an upstream key-change to
 *  zero-or-more keys in *this* pass's key-space, enqueuing them for
 *  re-transfer. An edge without `wake` is a dependency-only declaration —
 *  the pass reads from `ctx.read(upstream, ...)` in `transfer` but does not
 *  auto-wake on upstream writes (its own `affectedKeys` handles dispatch, or
 *  it genuinely doesn't need to react). */
export interface EdgeSpec<K> {
  readonly pass: Pass<any, any>;
  wake?(ctx: PassCtx, key: unknown): Iterable<K>;
}

/** Append an `EdgeSpec` to a pass's `edges` after construction. Encapsulates
 *  the readonly-cast that would otherwise leak at every call site. Intended
 *  for passes with mutually-recursive edges that can't be declared at
 *  literal-construction time (e.g. purity block ↔ scope). MUST be called
 *  before the pass is registered with a worklist — the worklist snapshots
 *  `edges` during `register`, and later amendments will not take effect. */
export function addEdge<K>(pass: Pass<K, any>, spec: EdgeSpec<K>): void {
  (pass.edges as EdgeSpec<K>[]).push(spec);
}

/** A computation over the fact store. `transfer` returning `undefined` means "no write". */
export interface Pass<K, V> {
  readonly id: symbol;
  readonly debugName: string;
  readonly lattice: Lattice<V>;
  readonly edges: ReadonlyArray<EdgeSpec<K>>;
  readonly tier?: "runtime" | "analysis" | "transform";
  transfer(ctx: PassCtx, key: K): V | undefined;
  /** Custom wake dispatch, overriding per-edge `wake` functions. If present,
   *  the worklist calls this for every upstream change and ignores `wake`. */
  affectedKeys?(
    ctx: PassCtx,
    triggerPass: Pass<any, any>,
    triggerKey: unknown,
  ): Iterable<K>;
  /** Called on CFG rebuild. `previousKeys` spans all units; return keys to evict. */
  prune?(ctx: PassCtx, unit: FunctionUnit, previousKeys: Iterable<K>): Iterable<K>;
}

/** View handed to `Pass.transfer`. */
export interface PassCtx {
  /** Current fact, or lattice `bottom` if no cell exists. */
  read<K2, V2>(p: Pass<K2, V2>, key: K2): V2;
  /** Current fact, or `undefined` if unset. */
  tryRead<K2, V2>(p: Pass<K2, V2>, key: K2): V2 | undefined;
  readAll<K2, V2>(p: Pass<K2, V2>): ReadonlyMap<K2, V2>;
  /** Outermost containing unit for a node. */
  unitForNode(nodeId: number): FunctionUnit | undefined;
  /** Every unit whose `blockOfNode` indexes this node. */
  unitsContainingNode(nodeId: number): ReadonlyArray<FunctionUnit>;
  /** Unit for a `FunctionDef.id`. */
  unitForFdId(fdId: number): FunctionUnit | undefined;
  /** Internal-only: reserved for DFA factory's block fixpoint. */
  readonly factStore: FactStore;
}
