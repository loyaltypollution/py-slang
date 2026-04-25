import type { NodeId } from "./framework/analysis";
import type { FunctionView } from "./program/program-view";
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
 *  The `FunctionView` handle is the seam where node-keyed reads
 *  materialize from block-keyed storage (`perExpr` walks block → env →
 *  expr-fact at the node's position). */
interface FutureDispatchView extends FunctionView {
  futureDispatchChainForNode(nodeId: NodeId): AssumptionChain;
}

function hasFutureDispatchView(view: FunctionView): view is FutureDispatchView {
  return typeof (view as Partial<FutureDispatchView>).futureDispatchChainForNode === "function";
}

export function makeDfaQuery(
  view: FunctionView,
  futureDispatchChainForNode?: (nodeId: NodeId) => AssumptionChain,
): DfaQuery {
  const typeStore = typeAnalysis.perExpr(view);
  const constStore = constAnalysis.perExpr(view);
  const futureChain = futureDispatchChainForNode ?? (
    hasFutureDispatchView(view)
      ? (nodeId: NodeId) => view.futureDispatchChainForNode(nodeId)
      : () => ROOT_CONTEXT
  );
  return {
    typeOf: id => typeStore.tryRead(id, ROOT_CONTEXT),
    constOf: id => constStore.tryRead(id, ROOT_CONTEXT),
    speculativeTypeOf: id =>
      typeStore.tryRead(id, futureChain(id)),
    speculativeConstOf: id =>
      constStore.tryRead(id, futureChain(id)),
  };
}
