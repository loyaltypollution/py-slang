import type { NodeId } from "./framework/analysis";
import type { FunctionLocator } from "./program/function-locator";
import { ROOT_CONTEXT, type AssumptionChain } from "./assumption/chain";
import {
  constAnalysis,
  type ConstLattice,
  typeAnalysis,
  type TypeLattice,
} from "./analysis";

/** Node-keyed read surface, ROOT context only. Transforms accept this
 *  narrower type so the type system makes the P3 "transforms cannot read
 *  speculative facts" invariant unrepresentable. */
export interface StaticDfaQuery {
  typeOf(nodeId: NodeId): TypeLattice | undefined;
  constOf(nodeId: NodeId): ConstLattice | undefined;
}

/** Adds speculative-context readers (deepest fact at the node's chain).
 *  Backend lowering reads through this; transforms must not. */
export interface DfaQuery extends StaticDfaQuery {
  speculativeTypeOf(nodeId: NodeId): TypeLattice | undefined;
  speculativeConstOf(nodeId: NodeId): ConstLattice | undefined;
}

/** Thin facade over `typeAnalysis`/`constAnalysis` per-expression stores.
 *  `locator` is the seam where node-keyed reads materialize from block-keyed
 *  storage (`perExpr` walks block → env → expr-fact at the node's position).
 *  `futureDispatchChainForNode` is supplied explicitly — phase 5 splits the
 *  speculation-policy surface from the locator/registry. Defaults to ROOT
 *  for callers that have no per-node speculation chain. */
export function makeDfaQuery(
  locator: FunctionLocator,
  futureDispatchChainForNode: (nodeId: NodeId) => AssumptionChain = () => ROOT_CONTEXT,
): DfaQuery {
  const typeStore = typeAnalysis.perExpr(locator);
  const constStore = constAnalysis.perExpr(locator);
  return {
    typeOf: id => typeStore.tryRead(id, ROOT_CONTEXT),
    constOf: id => constStore.tryRead(id, ROOT_CONTEXT),
    speculativeTypeOf: id =>
      typeStore.tryRead(id, futureDispatchChainForNode(id)),
    speculativeConstOf: id =>
      constStore.tryRead(id, futureDispatchChainForNode(id)),
  };
}
