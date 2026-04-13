import { BasicEvaluator } from "@sourceacademy/conductor/runner";
import { StmtNS } from "../ast-types";
import { SVMLCompiler } from "../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../engines/svml/svml-interpreter";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import {
  ConstAnalysisPass,
  MemoizationTransformRule,
  TypeAnalysisPass,
  Worklist,
  callCountPass,
  purityScopePass,
  runtimeCallPass,
  runtimeWritePass,
  structuralPass,
} from "../specialization";
import type { FunctionUnit } from "../specialization/framework/function-unit";
import type { Pass, PassCtx } from "../specialization/framework/pass";
import { EvaluatorError } from "./errors";

/**
 * SVML evaluator with JIT specialization. After static convergence and
 * compile, runtime observations drive further transforms; each mutated
 * FunctionDef is recompiled and patched into the function table.
 *
 * PR-5 wiring: the interpreter's STORE / CALL sites push into the
 * worklist's fact store via `worklist.observe(runtimeWritePass, …)` and
 * `worklist.observe(runtimeCallPass, …)` alongside the legacy
 * `observationSink` calls. A registered `jitPass` reads
 * `[callCountPass, purityScopePass, structuralPass]` and recompiles +
 * patches the function whenever its compiled-IR digest actually
 * changes (side-effect idempotence rule). The legacy
 * `onScopeChanged` callback is kept live alongside; PR-6 demolishes it.
 */
export class PySvmlJitEvaluator extends BasicEvaluator {
  async evaluateChunk(chunk: string): Promise<void> {
    try {
      const script = chunk + "\n";
      const ast = parse(script);
      const { errors, environments } = analyzeWithEnvironments(ast, script, 4);
      if (errors.length > 0) throw errors[0];

      const worklist = new Worklist(
        ast,
        environments,
        [
          new TypeAnalysisPass(),
          new ConstAnalysisPass(),
        ],
        [
          new MemoizationTransformRule(),
        ],
        [],
      );
      worklist.converge();

      const compiler = SVMLCompiler.fromProgramUnit(ast, environments, worklist.units);
      const program = compiler.compileProgram(ast);

      // Per-callee raw count map for runtimeCallPass.
      const callCounts = new Map<number, number>();

      const interpreter = new SVMLInterpreter(program, {
        sendOutput: this.conductor.sendOutput,
        observationSink: worklist,
        observeNodeWrite: (nodeId, value) => {
          worklist.observe(runtimeWritePass, nodeId, value);
        },
        observeScopeCall: (scopeId) => {
          const next = (callCounts.get(scopeId) ?? 0) + 1;
          callCounts.set(scopeId, next);
          worklist.observe(runtimeCallPass, scopeId, next);
        },
      });

      // ── jitPass: recompile + patch on lattice-change of compile-relevant
      // facts. Side-effect idempotence: patchFunction only fires when the
      // produced digest differs from the previously-stored one. Both
      // `transfer` and the digest computation are `coarse: true` over the
      // unit keyspace.
      const jitPass: Pass<FunctionUnit, number> = {
        id: Symbol("jitPass"),
        debugName: "jitPass",
        lattice: {
          bottom: 0,
          equals: (a, b) => a === b,
          join: (a, b) => Math.max(a, b),
        },
        reads: [callCountPass, purityScopePass, structuralPass],
        tier: "jit",
        coarse: true,
        // affectedKeys: any change in a read pass invalidates *every*
        // FunctionDef unit. Without this the coarse fallback (re-run on
        // previously-written keys) would never wake jitPass before its
        // first own write, breaking the priming order.
        affectedKeys(_triggerPass, _triggerKey) {
          return Array.from(worklist.units.values());
        },
        transfer(_ctx: PassCtx, unit: FunctionUnit): number | undefined {
          const scope = unit.funcAst;
          if (!(scope instanceof StmtNS.FunctionDef)) return undefined;
          const index = compiler.indexOf(scope);
          if (index === undefined) return undefined;
          const newCode = compiler.compileFunction(unit);
          const digest = digestSVMLIR(newCode);
          const prev = _ctx.read(jitPass, unit);
          if (digest === prev) return undefined; // equal → no write, no patch
          interpreter.patchFunction(index, newCode);
          return digest;
        },
      };
      worklist.register(jitPass);

      // Legacy onScopeChanged kept live alongside (PR-5 constraint;
      // PR-6 demolishes). May produce a redundant patch; tolerated.
      worklist.onScopeChanged((scope, unit) => {
        if (!(scope instanceof StmtNS.FunctionDef)) return;
        const index = compiler.indexOf(scope);
        if (index === undefined) return;
        interpreter.patchFunction(index, compiler.compileFunction(unit));
      });

      const returnValue = await interpreter.execute();
      this.conductor.sendResult(SVMLInterpreter.toJSValue(returnValue));
    } catch (e) {
      this.conductor.sendError(new EvaluatorError(e));
    }
  }
}

/**
 * Cheap structural digest for an SVMLIR. Combines opcode count with a
 * rolling XOR/multiply over opcodes and operand arrays. Not
 * cryptographic — collisions are tolerated only insofar as they
 * suppress one redundant patch; correctness comes from `patchFunction`
 * being idempotent. Hot-path cost: O(opcodes.length).
 */
function digestSVMLIR(ir: import("../engines/svml/types").SVMLIR): number {
  let h = ir.count | 0;
  const ops = ir.opcodes;
  for (let i = 0; i < ops.length; i++) {
    h = (h * 31 + ops[i]) | 0;
  }
  const a2 = ir.arg2s;
  for (let i = 0; i < a2.length; i++) {
    h = (h * 17 + a2[i]) | 0;
  }
  // arg1s is Float64; fold via DataView trick avoided — sum suffices for
  // change detection given opcodes already discriminate structure.
  const a1 = ir.arg1s;
  for (let i = 0; i < a1.length; i++) {
    h = (h * 13 + (a1[i] | 0)) | 0;
  }
  return h;
}
