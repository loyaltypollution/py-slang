// JIT recompile-and-patch pass. Reads compile-relevant fact-store signals
// (callCount, purity, structural) and, on lattice-change, recompiles the
// affected FunctionDef and patches its entry in the interpreter's function
// table. Side-effect idempotence: patchFunction only fires when the
// produced IR differs structurally from the previously-stored one; the
// IR itself is the lattice value, so equal writes suppress onChange.

import { StmtNS } from "../../ast-types";
import type { FunctionUnit } from "../../specialization/framework/function-unit";
import type { Pass, PassCtx } from "../../specialization/framework/pass";
import { constAnalysisPass } from "../../specialization/const-analysis/analysis";
import { structuralPass } from "../../specialization/framework/structural-pass";
import { callCountPass } from "../../specialization/memoization-analysis/call-count";
import { purityScopePass } from "../../specialization/purity-analysis/analysis";
import { typeAnalysisPass } from "../../specialization/type-analysis/analysis";
import type { SVMLCompiler } from "./svml-compiler";
import type { SVMLInterpreter } from "./svml-interpreter";
import { SVMLIR } from "./types";

/** Memoized snapshot of the inputs that determine a unit's compiled IR.
 *  `analysisGen` counts node-level type/const fact changes within this unit;
 *  compileFunction reads those via factStore, so any change must invalidate. */
interface CompileInputs {
  structuralGen: number;
  callCount: number;
  purity: unknown;
  analysisGen: number;
}

export interface JitPassDeps {
  readonly compiler: SVMLCompiler;
  readonly interpreter: SVMLInterpreter;
  /** Source of unit fan-out on coarse recompile triggers. */
  readonly unitsOf: () => Iterable<FunctionUnit>;
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

export function makeJitPass(deps: JitPassDeps): Pass<FunctionUnit, SVMLIR> {
  const { compiler, interpreter, unitsOf } = deps;

  // Per-unit snapshot of the (structuralGen, callCount, purity) tuple that
  // determines compilation output. On trigger, if the snapshot matches the
  // current fact-store values, skip compileFunction entirely.
  const lastInputs = new WeakMap<FunctionUnit, CompileInputs>();
  // Per-unit tick bumped whenever a node-level type/const fact changes within
  // the unit. compileFunction reads typeAnalysisPass/constAnalysisPass on a
  // per-node basis, so the memo snapshot must invalidate on any such change.
  const analysisGen = new WeakMap<FunctionUnit, number>();

  const jitPass: Pass<FunctionUnit, SVMLIR> = {
    id: Symbol("jitPass"),
    debugName: "jitPass",
    lattice: {
      bottom: UNCOMPILED,
      equals: structuralEquals,
      join: (_a, b) => b,
    },
    reads: [callCountPass, purityScopePass, structuralPass, typeAnalysisPass, constAnalysisPass],
    tier: "transform",
    affectedKeys(ctx, triggerPass, triggerKey) {
      if (triggerPass === callCountPass || triggerPass === purityScopePass) {
        const unit = ctx.unitForFdId(triggerKey as number);
        return unit === undefined ? [] : [unit];
      }
      if (triggerPass === structuralPass) {
        return [triggerKey as FunctionUnit];
      }
      if (triggerPass === typeAnalysisPass || triggerPass === constAnalysisPass) {
        // A node may be indexed by multiple units (e.g. a FunctionDef body
        // node is also indexed in the enclosing FileInput's CFG). Bump
        // analysisGen for every containing unit so the memo invalidates
        // correctly regardless of nesting; only enqueue FunctionDef units
        // since jitPass only produces IR for those.
        const nodeId = triggerKey as number;
        const containing = ctx.unitsContainingNode(nodeId);
        const affected: FunctionUnit[] = [];
        for (const u of containing) {
          analysisGen.set(u, (analysisGen.get(u) ?? 0) + 1);
          if (u.funcAst instanceof StmtNS.FunctionDef) affected.push(u);
        }
        return affected;
      }
      return Array.from(unitsOf());
    },
    transfer(ctx: PassCtx, unit: FunctionUnit): SVMLIR | undefined {
      const scope = unit.funcAst;
      if (!(scope instanceof StmtNS.FunctionDef)) return undefined;
      const index = compiler.indexOf(scope);
      if (index === undefined) return undefined;

      const curInputs: CompileInputs = {
        structuralGen: unit.generation,
        callCount: ctx.read(callCountPass, scope.id),
        purity: ctx.read(purityScopePass, scope.id),
        analysisGen: analysisGen.get(unit) ?? 0,
      };
      const prevInputs = lastInputs.get(unit);
      if (
        prevInputs !== undefined &&
        prevInputs.structuralGen === curInputs.structuralGen &&
        prevInputs.callCount === curInputs.callCount &&
        prevInputs.purity === curInputs.purity &&
        prevInputs.analysisGen === curInputs.analysisGen
      ) {
        return undefined;
      }

      const newCode = compiler.compileFunction(unit);
      lastInputs.set(unit, curInputs);
      const prev = ctx.read(jitPass, unit);
      if (structuralEquals(newCode, prev)) return undefined;
      interpreter.patchFunction(index, newCode);
      return newCode;
    },
  };
  return jitPass;
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
