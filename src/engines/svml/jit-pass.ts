// JIT recompile-and-patch pass. Reads compile-relevant fact-store signals
// (callCount, purity, structural) and, on lattice-change, recompiles the
// affected FunctionDef and patches its entry in the interpreter's function
// table. Side-effect idempotence: patchFunction only fires when the
// produced IR differs structurally from the previously-stored one; the
// IR itself is the lattice value, so equal writes suppress onChange.

import { StmtNS } from "../../ast-types";
import type { FunctionUnit } from "../../specialization/framework/function-unit";
import type { Pass, PassCtx } from "../../specialization/framework/pass";
import { structuralPass } from "../../specialization/framework/structural-pass";
import { callCountPass } from "../../specialization/memoization-analysis/call-count";
import { purityScopePass } from "../../specialization/purity-analysis/analysis";
import type { SVMLCompiler } from "./svml-compiler";
import type { SVMLInterpreter } from "./svml-interpreter";
import { SVMLIR } from "./types";

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

  const jitPass: Pass<FunctionUnit, SVMLIR> = {
    id: Symbol("jitPass"),
    debugName: "jitPass",
    lattice: {
      bottom: UNCOMPILED,
      equals: structuralEquals,
      join: (_a, b) => b,
    },
    reads: [callCountPass, purityScopePass, structuralPass],
    tier: "transform",
    // Any change in a read pass invalidates every FunctionDef unit.
    affectedKeys(_ctx, _triggerPass, _triggerKey) {
      return Array.from(unitsOf());
    },
    transfer(ctx: PassCtx, unit: FunctionUnit): SVMLIR | undefined {
      const scope = unit.funcAst;
      if (!(scope instanceof StmtNS.FunctionDef)) return undefined;
      const index = compiler.indexOf(scope);
      if (index === undefined) return undefined;
      const newCode = compiler.compileFunction(unit);
      const prev = ctx.read(jitPass, unit);
      if (structuralEquals(newCode, prev)) return undefined; // no write, no patch
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
