import { constAnalysisModule, speculativeConstAnalysisModule } from "../const-analysis/analysis";
import type { ConstLattice } from "../const-analysis/lattice";
import { typeAnalysisModule } from "../type-analysis/analysis";
import type { TypeLattice } from "../type-analysis/lattice";
import { transferBlock } from "./block-transfer";
import type { BasicBlock } from "./cfg";
import { nodeIdToBlock, type DfaBlockFact, makeBlockFixpointAnalysis } from "./dfa-factory";
import type { BlockDfaSpec } from "./interfaces";
import { MutableEnv } from "./mutable-env";
import { addEdge, type Analysis } from "./analysis";
import { runtimeWriteAnalysis } from "./runtime-analyses";

function dfaAnalysis<L>(
  debugName: string,
  spec: BlockDfaSpec<L>,
  accumulationMode: "monotone" | "overwrite" = "monotone",
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
    accumulationMode,
  });
  if (accumulationMode === "overwrite") {
    // Narrowing fixpoints don't converge monotonically through loops:
    // Block 0 narrows via observation → m: INT_POS; Block 1 joins with the
    // loop-back edge from Block 3, whose outEnv is still the pre-observation
    // widened state → m: TOP. The narrowed fact is absorbed and never
    // propagates past the header. Fix: when the observation changes, evict
    // all block cells in the affected unit and re-seed from entry. The
    // iteration then runs with a clean back-edge (initially ⊥, not stale
    // TOP), narrowing flows forward, and the back-edge carries the narrowed
    // body outEnv. Monotone widening analyses keep `nodeIdToBlock` — their
    // fixpoint converges without eviction. */
    addEdge(analysis, {
      on: "fact",
      analysis: runtimeWriteAnalysis,
      effect: (factStore, ctx, key) => {
        if (typeof key !== "number") return;
        const unit = ctx.unitForNode(key);
        if (unit === undefined) return;
        for (const block of unit.blockMap.values()) {
          factStore.evict(analysis, block);
        }
      },
      wake: (ctx, key) => {
        if (typeof key !== "number") return [];
        const unit = ctx.unitForNode(key);
        if (unit === undefined) return [];
        // Re-seed from the CFG entry; self-wake will cascade to successors.
        return spec.direction === "forward"
          ? [unit.cfg.entry]
          : [unit.cfg.exit];
      },
    });
  } else {
    addEdge(analysis, { on: "fact", analysis: runtimeWriteAnalysis, wake: nodeIdToBlock });
  }
  return analysis;
}

export const typeAnalysis: Analysis<BasicBlock, DfaBlockFact<TypeLattice>> =
  dfaAnalysis("typeAnalysis", typeAnalysisModule);
export const constAnalysis: Analysis<BasicBlock, DfaBlockFact<ConstLattice>> =
  dfaAnalysis("constAnalysis", constAnalysisModule);

/** Speculative const analysis: observations narrow (`meet`) instead of
 *  widening (`join`). Reads are sound only for consumers that emit a runtime
 *  guard at the specialized site (currently: `svml-compiler` via
 *  `jit-analysis`). AST-mutating transforms MUST continue to read the
 *  standard analyses — narrowed facts are speculative and unsound for AST
 *  mutation.
 *
 *  Type speculation has been migrated to `typeAnalysis` running under a
 *  per-unit speculation Context (see `Worklist.currentSpecContext` + the
 *  observation-to-context translator). The const-analysis migration is
 *  pending (matching shape; blocks deletion of `"overwrite"` accumulation
 *  mode from `dfa-factory`). */
export const speculativeConstAnalysis: Analysis<BasicBlock, DfaBlockFact<ConstLattice>> =
  dfaAnalysis("speculativeConstAnalysis", speculativeConstAnalysisModule, "overwrite");
