import { constAnalysisModule, constExprHandle, constValueEqual, liftConst } from "../const-analysis/analysis";
import type { ConstLattice } from "../const-analysis/lattice";
import { liftType, typeAnalysisModule, typeExprHandle, typeValueEqual } from "../type-analysis/analysis";
import type { TypeLattice } from "../type-analysis/lattice";
import { transferBlock } from "./block-transfer";
import type { BasicBlock } from "./cfg";
import { nodeIdToBlock, type DfaBlockFact, makeBlockFixpointAnalysis } from "./dfa-factory";
import type { BlockDfaSpec } from "./interfaces";
import { MutableEnv } from "./mutable-env";
import { addEdge, type Analysis, type NarrowingSpec, type SpecAnchorInfo } from "./analysis";
import { runtimeWriteAnalysis } from "./runtime-analyses";

function dfaAnalysis<L>(
  debugName: string,
  spec: BlockDfaSpec<L>,
): Analysis<BasicBlock, DfaBlockFact<L>> {
  const analysis = makeBlockFixpointAnalysis<L>({
    debugName,
    direction: spec.direction,
    valueLattice: spec,
    mergeKind: spec.mergeKind,
    seedEnv: () => new MutableEnv<L>(),
    transferBlock: (factStore, ctx, block, inEnv, unit) =>
      transferBlock(block, inEnv, spec, factStore, unit.slotLookup, ctx.currentContext),
    refineOnEdge: (env, edge) => spec.refineOnEdge(env, edge),
  });
  // Monotone widening edge: a ROOT observation change wakes the containing
  // block so the static/widened fact can advance. Speculative narrowing
  // rides the Context dimension instead — see the observation→context
  // translator on Worklist.
  addEdge(analysis, { on: "fact", analysis: runtimeWriteAnalysis, wake: nodeIdToBlock });
  return analysis;
}

export const typeAnalysis: Analysis<BasicBlock, DfaBlockFact<TypeLattice>> =
  dfaAnalysis("typeAnalysis", typeAnalysisModule);
export const constAnalysis: Analysis<BasicBlock, DfaBlockFact<ConstLattice>> =
  dfaAnalysis("constAnalysis", constAnalysisModule);

/** Attach a `specAnchor` to a context-anchor handle after the block DFA it
 *  names has been constructed. Colocates the handle↔block-analysis pairing
 *  with the block-analysis creation site; `Worklist.widenGuard`'s lineage
 *  walk reads `ref.analysis.specAnchor` directly and throws a descriptive
 *  error when a published guard's handle has no pairing declared.
 *
 *  The cast sidesteps the `readonly specAnchor?` declaration on `Analysis`;
 *  the field is conceptually frozen once set and never re-assigned. */
function attachSpecAnchor<K, V>(handle: Analysis<K, V>, anchor: SpecAnchorInfo<V>): void {
  (handle as { specAnchor?: SpecAnchorInfo<V> }).specAnchor = anchor;
}

// Wire speculation-anchor pairings. A handle without a pairing is
// structurally unable to back a guard — the error is raised inside
// `Worklist.widenGuard` the first time a deopt walks to this handle.
attachSpecAnchor(constExprHandle, {
  blockAnalysis: () => constAnalysis,
  valueEqual: constValueEqual,
});
attachSpecAnchor(typeExprHandle, {
  blockAnalysis: () => typeAnalysis,
  valueEqual: typeValueEqual,
});

/** Narrowing dimensions exposed to the observation→context translator.
 *  Registering one here is the full surface for adding a speculation
 *  dimension: the worklist's observation translator, widen primitives,
 *  and `lineageOf` iterate this list. No framework edits required. */
export const typeNarrowing: NarrowingSpec<TypeLattice> = {
  handle: typeExprHandle,
  lift: liftType,
};
export const constNarrowing: NarrowingSpec<ConstLattice> = {
  handle: constExprHandle,
  lift: liftConst,
};

/** Default narrowing set. Worklist callers that omit the constructor's
 *  `narrowings` parameter get this list. */
export const DEFAULT_NARROWINGS: ReadonlyArray<NarrowingSpec<any>> = [
  typeNarrowing,
  constNarrowing,
];
