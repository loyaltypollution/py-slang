// SVML JIT recompile-and-patch analysis.
//
// This is the evaluator-local publication hook for SVML: when compile-relevant
// facts or the unit's active speculation context change, recompile the unit's
// current artifact and patch the interpreter's function table if the emitted IR
// changed. The runtime speculation domain is policy-limited upstream; this
// module consumes the active AssumptionChain as-is and does not cache or widen
// artifacts locally.

import { StmtNS } from "../ast-types";
import type { BasicBlock } from "../specialization/framework/cfg";
import { ROOT_CONTEXT, type AssumptionChain } from "../specialization/framework/context";
import type { Unit } from "../specialization/framework/function-unit";
import { defineAnalysis, type Analysis, type AnalysisCtx, type EdgeSpec, type Narrowing } from "../specialization/framework/analysis";
import { storeEvict } from "../specialization/framework/analysis-store";
import { JIT_RELEVANT_NARROWINGS } from "../specialization/framework/dfa-analyses";
import { runtimeCallAnalysis } from "../specialization/framework/runtime-analyses";
import { purityScopeAnalysis } from "../specialization/purity-analysis/analysis";
import type { SVMLCompiler } from "../engines/svml/svml-compiler";
import type { SVMLInterpreter } from "../engines/svml/svml-interpreter";
import { SVMLIR } from "../engines/svml/types";
import {
  contextIsEntrySpecializable,
  directParamEntryGuardsFor,
  guardKeyFromGuards,
  type EntryGuard,
} from "../specialization/entry-guards";
import { specializedBodyFor } from "../specialization/speculative-clone";
import { MEMOIZATION_THRESHOLD } from "../specialization/transforms/memoization";

interface CompiledArtifactDescriptor {
  readonly artifactContext: AssumptionChain;
  readonly specBody: ReadonlyArray<StmtNS.Stmt> | undefined;
  readonly entryGuards: ReadonlyArray<EntryGuard> | undefined;
  readonly entryGuardKey: string | undefined;
}

/** Expand a narrowing into its cell analyses (both `.env` and `.facts`) so the
 *  JIT wakes whenever either half of a compile-relevant block DFA advances. */
function cellsOfNarrowing(n: Narrowing<any>): Array<Analysis<BasicBlock, unknown>> {
  const bfa = n.blockAnalysis();
  return [
    bfa.env as Analysis<BasicBlock, unknown>,
    bfa.facts as Analysis<BasicBlock, unknown>,
  ];
}

function blockToOwningUnit(_ctx: AnalysisCtx, key: unknown): Iterable<Unit> {
  const block = key as BasicBlock;
  const unit = block.unit;
  if (unit === undefined) return [];
  return unit.funcAst instanceof StmtNS.FunctionDef ? [unit] : [];
}

/** Sentinel "not yet compiled" — a unique SVMLIR instance distinct from every real one by reference. */
const UNCOMPILED: SVMLIR = new SVMLIR(
  new Int32Array(0),
  new Float64Array(0),
  new Int32Array(0),
  [],
  0,
  0,
  0,
);

export interface JitPassDeps {
  readonly compiler: SVMLCompiler;
  readonly interpreter: SVMLInterpreter;
  readonly specAssumptionChainFor?: (unit: Unit) => AssumptionChain;
  readonly narrowings?: ReadonlyArray<Narrowing<any>>;
}

function compiledEntryGuardsFor(
  unit: Unit,
  context: AssumptionChain,
): ReadonlyArray<EntryGuard> | undefined {
  if (!contextIsEntrySpecializable(unit, context)) return undefined;
  return directParamEntryGuardsFor(unit, context);
}

/** Produce the SVML-emission descriptor at `artifactContext`. The body
 *  comes from the chain-body-store via `specializedBodyFor`: if
 *  memoizationRule fired at an ancestor of this context, the memo prelude
 *  is already inlined; speculative dead-branch pruning is then applied as
 *  a backend-local clone for IR size. Memoization policy lives entirely
 *  in `memoizationRule` now; there is no JIT-side memoization decision. */
function describeCompiledArtifact(
  unit: Unit,
  artifactContext: AssumptionChain,
  topology: AnalysisCtx["topology"],
): CompiledArtifactDescriptor {
  const specBody = specializedBodyFor(unit, artifactContext, topology);
  const entryGuards = compiledEntryGuardsFor(unit, artifactContext);
  return {
    artifactContext,
    specBody,
    entryGuards,
    entryGuardKey: guardKeyFromGuards(entryGuards),
  };
}

export function makeJitAnalysis(deps: JitPassDeps): Analysis<Unit, SVMLIR> {
  const { compiler, interpreter } = deps;
  const specAssumptionChainFor = deps.specAssumptionChainFor ?? ((_: Unit) => ROOT_CONTEXT);
  const narrowings = deps.narrowings ?? JIT_RELEVANT_NARROWINGS;

  const edges: EdgeSpec<Unit>[] = narrowings.flatMap(n =>
    cellsOfNarrowing(n).map(cell => ({
      on: "fact" as const,
      analysis: cell,
      wake: blockToOwningUnit,
      contextPolicy: "root" as const,
    })),
  );
  edges.push(
    {
      on: "fact",
      analysis: runtimeCallAnalysis,
      wake: (ctx, functionId) => {
        const count = runtimeCallAnalysis.store.tryRead(functionId as number, ROOT_CONTEXT) ?? 0;
        if (count !== MEMOIZATION_THRESHOLD) return [];
        const u = ctx.topology.unitOfFunctionId(functionId as number);
        return u !== undefined && u.funcAst instanceof StmtNS.FunctionDef ? [u] : [];
      },
      contextPolicy: "root",
    },
    {
      // Purity verdict landing at any ancestor of the unit's active spec
      // context may unlock memoization in the clone lane. The body the JIT
      // emits is gated on a minimal-witness read of purityScopeAnalysis, so
      // a write to any context is a candidate trigger — the transfer
      // re-derives the witness and suppresses via structural-equals if the
      // emitted IR is unchanged.
      on: "fact",
      analysis: purityScopeAnalysis,
      wake: (ctx, functionId) => {
        const u = ctx.topology.unitOfFunctionId(functionId as number);
        return u !== undefined && u.funcAst instanceof StmtNS.FunctionDef ? [u] : [];
      },
      contextPolicy: "root",
    },
    {
      on: "mint",
      wake: (_ctx, unit) =>
        unit.funcAst instanceof StmtNS.FunctionDef ? [unit] : [],
    },
    {
      on: "rebuild",
      wake: (_ctx, unit) =>
        unit.funcAst instanceof StmtNS.FunctionDef ? [unit] : [],
    },
    {
      on: "specContextChange",
      wake: (_ctx, unit) =>
        unit.funcAst instanceof StmtNS.FunctionDef ? [unit] : [],
    },
  );

  const jitStoreAlgebra = {
    bottom: UNCOMPILED,
    leq: structuralEquals,
    join: (_a: SVMLIR, b: SVMLIR) => b,
    eq: structuralEquals,
  };

  const jitAnalysis: Analysis<Unit, SVMLIR> = defineAnalysis({
    id: Symbol("jitAnalysis"),
    debugName: "jitAnalysis",
    storeAlgebra: jitStoreAlgebra,
    edges,
    tier: "analysis",
    polarity: "opaque",
    transfer(ctx: AnalysisCtx, unit: Unit): SVMLIR | undefined {
      const scope = unit.funcAst;
      if (!(scope instanceof StmtNS.FunctionDef)) return undefined;
      const index = compiler.indexOf(scope);
      if (index === undefined) return undefined;

      const artifact = describeCompiledArtifact(unit, specAssumptionChainFor(unit), ctx.topology);
      const newCode = compiler.compileFunction(unit, artifact.specBody, artifact.entryGuards);
      const prevIR = jitAnalysis.store.read(unit, ROOT_CONTEXT);
      if (structuralEquals(newCode, prevIR)) return undefined;
      interpreter.patchFunction(index, newCode);
      return newCode;
    },
  });

  (jitAnalysis.edges as EdgeSpec<Unit>[]).push({
    on: "retire",
    effect: (_ctx, unit) => {
      storeEvict(jitAnalysis.store, unit, ROOT_CONTEXT);
    },
  });
  return jitAnalysis;
}

/**
 * Collision-free structural equality over two SVMLIR instances. Fails fast
 * on first divergence. A hash would risk suppressing a required patchFunction.
 */
function i32Equals(a: Int32Array, b: Int32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Float64: bitwise NaN-safe compare — two NaNs compare equal if bit-identical.
function f64Equals(a: Float64Array, b: Float64Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x !== y && !(Number.isNaN(x) && Number.isNaN(y))) return false;
  }
  return true;
}

function strEquals(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function structuralEquals(a: SVMLIR, b: SVMLIR): boolean {
  if (a === b) return true;
  return (
    a.count === b.count &&
    a.stackSize === b.stackSize &&
    a.envSize === b.envSize &&
    a.numArgs === b.numArgs &&
    i32Equals(a.opcodes, b.opcodes) &&
    i32Equals(a.arg2s, b.arg2s) &&
    f64Equals(a.arg1s, b.arg1s) &&
    strEquals(a.strings, b.strings)
  );
}
