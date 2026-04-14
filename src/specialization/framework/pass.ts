import type { FunctionUnit } from "./function-unit";
import type { FactStore } from "./fact-store";

/** Value-space algebra. `equals` gates change events; `bottom` is returned for unwritten cells. */
export interface Lattice<V> {
  readonly bottom: V;
  equals(a: V, b: V): boolean;
  join(a: V, b: V): V;
}

/** A read declaration: either a bare `Pass` (legacy — same key-space identity
 *  projection, or user provides `affectedKeys`) or `{ pass, project }` where
 *  the projector maps an upstream key to zero-or-more keys in *this* pass's
 *  key-space. When every entry carries a projector AND the pass omits
 *  `affectedKeys`, the worklist synthesizes dispatch automatically — one
 *  source of truth per upstream dependency. */
export type ReadSpec<K> =
  | Pass<any, any>
  | ProjectorRead<K>;

export interface ProjectorRead<K> {
  readonly pass: Pass<any, any>;
  readonly project: (ctx: PassCtx, key: unknown) => Iterable<K>;
}

/** Discriminate `ReadSpec`: a projector entry has a callable `project` field.
 *  Checking for `project` (not `pass`) is load-bearing — `Pass` has no
 *  `project` field, and this narrows safely even if `Pass` ever grows a
 *  `pass` property. */
export function isProjectorRead<K>(spec: ReadSpec<K>): spec is ProjectorRead<K> {
  return typeof (spec as ProjectorRead<K>).project === "function";
}

/** Extract the underlying upstream `Pass` from a `ReadSpec`. */
export function readSpecPass(spec: ReadSpec<any>): Pass<any, any> {
  return isProjectorRead(spec) ? spec.pass : spec;
}

/** A computation over the fact store. `transfer` returning `undefined` means "no write". */
export interface Pass<K, V> {
  readonly id: symbol;
  readonly debugName: string;
  readonly lattice: Lattice<V>;
  readonly reads: ReadonlyArray<ReadSpec<K>>;
  readonly tier?: "runtime" | "analysis" | "transform";
  /** If set, on any upstream write this pass re-transfers over **every
   *  previously-written key** (O(N) per upstream change). Prefer
   *  `affectedKeys` when you can narrow the set — `coarse: true` silently
   *  amplifies to quadratic work when the upstream is a high-fanout source
   *  like `runtimeWritePass` or `runtimeCallPass`. Mutually exclusive with
   *  `affectedKeys`; one is required. */
  readonly coarse?: boolean;
  transfer(ctx: PassCtx, key: K): V | undefined;
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
