import { constAnalysisModule, speculativeConstAnalysisModule } from "../const-analysis/analysis";
import type { ConstLattice } from "../const-analysis/lattice";
import { speculativeTypeAnalysisModule, typeAnalysisModule } from "../type-analysis/analysis";
import type { TypeLattice } from "../type-analysis/lattice";
import { transferBlock } from "./block-transfer";
import type { BasicBlock } from "./cfg";
import { nodeIdToBlock, type DfaBlockFact, makeBlockFixpointPass } from "./dfa-factory";
import type { BlockDfaSpec } from "./interfaces";
import { MutableEnv } from "./mutable-env";
import { addEdge, type Pass } from "./pass";
import { runtimeWritePass } from "./runtime-passes";

function dfaPass<L>(
  debugName: string,
  spec: BlockDfaSpec<L>,
  accumulationMode: "monotone" | "overwrite" = "monotone",
): Pass<BasicBlock, DfaBlockFact<L>> {
  const pass = makeBlockFixpointPass<L>({
    debugName,
    direction: spec.direction,
    valueLattice: spec,
    mergeKind: spec.mergeKind,
    seedEnv: () => new MutableEnv<L>(),
    transferBlock: (factStore, _ctx, block, inEnv, unit) =>
      transferBlock(block, inEnv, spec, factStore, unit.slotLookup),
    refineOnEdge: (env, edge) => spec.refineOnEdge(env, edge),
    accumulationMode,
  });
  addEdge(pass, { on: "fact", pass: runtimeWritePass, wake: nodeIdToBlock });
  return pass;
}

export const typeAnalysisPass: Pass<BasicBlock, DfaBlockFact<TypeLattice>> =
  dfaPass("typeAnalysis", typeAnalysisModule);
export const constAnalysisPass: Pass<BasicBlock, DfaBlockFact<ConstLattice>> =
  dfaPass("constAnalysis", constAnalysisModule);

/** Speculative passes: same transfer logic, but observations narrow (`meet`)
 *  instead of widening (`join`). Reads are sound only for consumers that
 *  emit a runtime guard at the specialized site (currently: `svml-compiler`
 *  via `jit-pass`). AST-mutating transforms (`algebraic-simplify`,
 *  `dead-branch`, `constant-folding`) MUST continue to read the standard
 *  passes — narrowed facts are speculative and unsound for AST mutation,
 *  which the CSE arm cannot recover from. */
export const speculativeTypeAnalysisPass: Pass<BasicBlock, DfaBlockFact<TypeLattice>> =
  dfaPass("speculativeTypeAnalysis", speculativeTypeAnalysisModule, "overwrite");
export const speculativeConstAnalysisPass: Pass<BasicBlock, DfaBlockFact<ConstLattice>> =
  dfaPass("speculativeConstAnalysis", speculativeConstAnalysisModule, "overwrite");
