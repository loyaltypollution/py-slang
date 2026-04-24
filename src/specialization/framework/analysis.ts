import { AnalysisStore, type ReadonlyAnalysisStore } from "./analysis-store";
import type { AssumptionChain, NarrowingId } from "../assumption/chain";
import type { BlockFixpointAnalysis } from "./dfa-factory";
import type { Unit } from "./function-unit";
import type { ProgramTopology } from "./topology";
import type { Worklist } from "./worklist";
import type { BasicBlock } from "./cfg";

/** AST node id. Indexes individual expression/statement nodes. */
export type NodeId = number;

/** `FunctionDef.id` or `FileInput.id` — node id of a scope-owning AST node
 *  whose optimization unit is registered with the topology. Every
 *  `FunctionId` is also a `NodeId`; the distinction is semantic
 *  (topology.unitOfNode vs. topology.unitOfFunctionId). */
export type FunctionId = number;

/** Function-entry parameter identity, encoded as `${functionId}:${paramIndex}`
 *  so it is stable and usable directly as a Context/store key. Lives here
 *  (rather than narrowing-policy/) so the observation channel that types it
 *  and the narrowing that consumes it don't form a module cycle. */
export type ParamKey = `${FunctionId}:${number}`;

export function paramKey(functionId: FunctionId, paramIndex: number): ParamKey {
  return `${functionId}:${paramIndex}`;
}

export function paramKeyFunctionId(key: ParamKey): FunctionId {
  return Number(key.slice(0, key.indexOf(":")));
}

export function paramKeyIndex(key: ParamKey): number {
  return Number(key.slice(key.indexOf(":") + 1));
}

export type UnitResolver<K> = (ctx: AnalysisCtx, key: K) => Unit | undefined;

export const unitOfBlock: UnitResolver<BasicBlock> = (_ctx, block) => block.unit;
export const unitOfNodeId: UnitResolver<NodeId> = (ctx, nodeId) => ctx.topology.unitOfNode(nodeId);
export const unitOfFunctionId: UnitResolver<FunctionId> = (ctx, functionId) => ctx.topology.unitOfFunctionId(functionId);

export function wakeOwningUnit<K>(resolveUnit: UnitResolver<K>): (ctx: AnalysisCtx, key: K) => Iterable<Unit> {
  return (ctx, key) => {
    const unit = resolveUnit(ctx, key);
    return unit ? [unit] : [];
  };
}

export type SemanticAnalysis<K, V> = Analysis<K, V> & { polarity: "may" | "must" };

/** Algebra over one stored value space `V`. Drives `AnalysisStore`:
 *  `bottom` is the unwritten-cell default, `join` is storage combine,
 *  `eq` gates change detection. `leq` is the partial order (a ⊑ b). */
export interface JoinSemiLattice<V> {
  readonly bottom: V;
  leq(a: V, b: V): boolean;
  join(a: V, b: V): V;
  eq(a: V, b: V): boolean;
}

/** Bounded lattice: adds `top` and `meet`. Required by DFA value-lattices:
 *  `meet` is the dual merge for "must" analyses; `top` seeds widened slots. */
export interface Lattice<V> extends JoinSemiLattice<V> {
  readonly top: V;
  meet(a: V, b: V): V;
}

/** A computation over per-analysis fact cells. `K` is the key space
 *  (nodeId, functionId, `BasicBlock`, `Unit`, etc). `V` is the stored
 *  cell domain. `transfer` returning `undefined` means "no write". */
export interface Analysis<K, V> {
  readonly storeAlgebra: JoinSemiLattice<V>;
  /** Optional explicit value for an unwritten cell. Falls back to
   *  `storeAlgebra.bottom`. */
  readonly emptyValue?: V;
  /** Read-only cell surface. All outside-transfer queries go through `.store`;
   *  transfer-time reads go through `ctx` for dependency tracking. Internal
   *  mutation goes through helpers in `analysis-store.ts` so listener fan-out
   *  stays centralized. */
  readonly store: ReadonlyAnalysisStore<K, V>;
  /** Priority tier: runtime observations settle before analyses. Mandatory —
   *  no implicit default, to catch priority-sensitive miscompiles. */
  readonly tier: "runtime" | "analysis";
  /** Merge polarity: `"may"` = widening / over-approximate;
   *  `"must"` = intersecting / requirement-style. */
  readonly polarity: "may" | "must";
  /** Compute the next stored value at `key` under `ctx.currentContext`.
   *  Return `undefined` for "no write"; the worklist writes the returned
   *  value into `this.store` on the caller's behalf. */
  transfer(ctx: AnalysisCtx, key: K): V | undefined;

  /** Optional registration hook. Called by `Worklist.register`. */
  bind?(worklist: Worklist): void;
}

/** Sequentially compose an existing `bind` with an extension. Throws when
 *  `base` is undefined to catch "decorate a never-bound analysis" bugs. */
export function composeBind(
  base: ((wl: Worklist) => void) | undefined,
  extra: (wl: Worklist) => void,
): (wl: Worklist) => void {
  if (base === undefined) {
    throw new Error(
      "[composeBind] base bind is undefined — analysis has no prior bind to compose with.",
    );
  }
  return (wl) => {
    base(wl);
    extra(wl);
  };
}

/** Typed axis for extending a `AssumptionChain` chain. Contributions enter
 *  INSIDE `blockAnalysis()`'s transfer via `at(ctx, narrowing, key)` — a
 *  narrowing carries no lattice or store of its own, only the identity that
 *  lets chain bindings be looked up at transfer time. AnalysisStore cells
 *  partition per `(key, context)` natively, so refutation of a context
 *  leaves its cells unreachable without an eviction hook.
 *
 *  Observation glue (which runtime channel drives this dimension and how
 *  to lift a `RawKind` into V) lives in `ObservationBinding` so the
 *  framework stays observation-agnostic. */
export interface Narrowing<K = any, V = unknown> extends NarrowingId<K, V> {
  readonly blockAnalysis: () => BlockFixpointAnalysis<any>;
}

export interface AnalysisCtx {
  readonly topology: ProgramTopology;
  readonly currentContext: AssumptionChain;
  read<K, V>(analysis: Analysis<K, V>, key: K): V;
  tryRead<K, V>(analysis: Analysis<K, V>, key: K): V | undefined;
  readAll<K, V>(analysis: Analysis<K, V>): ReadonlyMap<K, V>;
  /** Write at `currentContext` and publish a `FactChange`. Use this for
   *  paired-cell side-effect writes (e.g. DFA `.facts` from inside `.env`'s
   *  transfer) — bypassing would skip listener fan-out. Transfer return
   *  values are dispatched automatically. Returns `true` iff the cell
   *  advanced. */
  write<K, V>(analysis: Analysis<K, V>, key: K, value: V): boolean;
  /** Evict at `currentContext`. */
  evict<K, V>(analysis: Analysis<K, V>, key: K): void;
}

/** Imperative AST sweep gated on analyses. No lattice, no transfer, no
 *  store write. The worklist dirties a rule on unit mint/rebuild and on
 *  writes to subscribed analyses; `sweep` runs once per dirty unit, and
 *  units that rewrote are scheduled for CFG rebuild. Idempotency across
 *  rebuilds is the rule's responsibility. */
export interface TransformRule {
  /** Returns `true` iff the body at `chain` was mutated — the worklist
   *  then schedules a CFG rebuild for `unit`. Worklist always passes
   *  `chain = futureDispatchChainFor(unit)`. */
  sweep(
    unit: Unit,
    chain: AssumptionChain,
    topology: ProgramTopology,
  ): boolean;
  bind?(worklist: Worklist): void;
}

/** Construct an Analysis, auto-attaching its `store` from `storeAlgebra`
 *  and `emptyValue`. */
export function defineAnalysis<
  K,
  V,
  P extends Analysis<K, V>["polarity"],
>(
  spec: Omit<Analysis<K, V>, "store" | "polarity"> & { polarity: P },
): Analysis<K, V> & { polarity: P } {
  const store = new AnalysisStore<K, V>(spec.storeAlgebra, spec.emptyValue);
  return { ...spec, store };
}
