// JIT recompile-and-patch pass. Reads compile-relevant fact-store signals
// (callCount, purity, structural) and, on lattice-change, recompiles the
// affected FunctionDef and patches its entry in the interpreter's function
// table. Side-effect idempotence: patchFunction only fires when the
// produced IR digest differs from the previously-stored one; the digest
// is also the lattice value, so equal writes suppress onChange.

import { StmtNS } from "../../ast-types";
import type { FunctionUnit } from "../../specialization/framework/function-unit";
import type { Pass, PassCtx } from "../../specialization/framework/pass";
import { structuralPass } from "../../specialization/framework/structural-pass";
import { callCountPass } from "../../specialization/memoization-analysis/call-count";
import { purityScopePass } from "../../specialization/purity-analysis/analysis";
import type { SVMLCompiler } from "./svml-compiler";
import type { SVMLInterpreter } from "./svml-interpreter";
import type { SVMLIR } from "./types";

export interface JitPassDeps {
  readonly compiler: SVMLCompiler;
  readonly interpreter: SVMLInterpreter;
  /** Source of unit fan-out on coarse recompile triggers. */
  readonly unitsOf: () => Iterable<FunctionUnit>;
}

export function makeJitPass(deps: JitPassDeps): Pass<FunctionUnit, number> {
  const { compiler, interpreter, unitsOf } = deps;

  const jitPass: Pass<FunctionUnit, number> = {
    id: Symbol("jitPass"),
    debugName: "jitPass",
    lattice: {
      bottom: 0,
      equals: (a, b) => a === b,
      join: (a, b) => Math.max(a, b),
    },
    reads: [callCountPass, purityScopePass, structuralPass],
    tier: "transform",
    coarse: true,
    // Any change in a read pass invalidates every FunctionDef unit.
    // Without this the coarse fallback (re-run on previously-written keys)
    // would never wake jitPass before its first own write, breaking the
    // priming order.
    affectedKeys(_ctx, _triggerPass, _triggerKey) {
      return Array.from(unitsOf());
    },
    transfer(ctx: PassCtx, unit: FunctionUnit): number | undefined {
      const scope = unit.funcAst;
      if (!(scope instanceof StmtNS.FunctionDef)) return undefined;
      const index = compiler.indexOf(scope);
      if (index === undefined) return undefined;
      const newCode = compiler.compileFunction(unit);
      const digest = digestSVMLIR(newCode);
      const prev = ctx.read(jitPass, unit);
      if (digest === prev) return undefined; // equal → no write, no patch
      interpreter.patchFunction(index, newCode);
      return digest;
    },
  };
  return jitPass;
}

/**
 * Cheap structural digest for an SVMLIR. Combines opcode count with a
 * rolling XOR/multiply over opcodes and operand arrays. Not
 * cryptographic — collisions are tolerated only insofar as they
 * suppress one redundant patch; correctness comes from `patchFunction`
 * being idempotent. Hot-path cost: O(opcodes.length).
 */
function digestSVMLIR(ir: SVMLIR): number {
  let h = ir.count | 0;
  const ops = ir.opcodes;
  for (let i = 0; i < ops.length; i++) {
    h = (h * 31 + ops[i]) | 0;
  }
  const a2 = ir.arg2s;
  for (let i = 0; i < a2.length; i++) {
    h = (h * 17 + a2[i]) | 0;
  }
  const a1 = ir.arg1s;
  for (let i = 0; i < a1.length; i++) {
    h = (h * 13 + (a1[i] | 0)) | 0;
  }
  return h;
}
