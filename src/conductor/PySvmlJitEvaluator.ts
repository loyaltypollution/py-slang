import { BasicEvaluator } from "@sourceacademy/conductor/runner";
import { SVMLCompiler } from "../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../engines/svml/svml-interpreter";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import {
  createDefaultWorklist,
  makeDfaQuery,
  makeJitDispatch,
} from "../specialization";
import math from "../stdlib/math";
import memo from "../stdlib/memo";
import misc from "../stdlib/misc";
import { EvaluatorError } from "./errors";

/**
 * SVML evaluator with JIT specialization — V2 collapse.
 *
 * No dispatch tree, no IR cache, no deopt path. Each CALL goes through
 * `dispatchCall`: publish observations, derive the specialized body under
 * the resulting (live-correct) chain, compile to fresh SVMLIR, return it
 * for this one invocation. Precision drift is impossible by construction:
 * the chain the body was pruned under is the same chain the arguments
 * produced a moment ago.
 *
 * Publication contract: this is the `"per-call"` granularity from
 * `specialization/publication.ts` — the artifact (`SVMLIR`) is captured
 * directly into the new call frame and never installed back into
 * `SVMLProgram`. `SVMLInterpreter.patchFunction` is a dormant hook for a
 * future `"slot-patch"` strategy; switching to it would not require any
 * specialization-framework change, only a different evaluator wiring that
 * runs `worklist.drain()` ahead of execution and patches slots between
 * runs.
 *
 * Symmetric with `PyCseJitEvaluator.dispatchCall`, modulo the final
 * `compiler.compileFunction` step that lowers the chosen body to bytecode.
 */
export class PySvmlJitEvaluator extends BasicEvaluator {
  async evaluateChunk(chunk: string): Promise<void> {
    try {
      const script = chunk + "\n";
      const ast = parse(script);
      const { errors, environments } = analyzeWithEnvironments(ast, script, 4, [
        misc,
        math,
        memo,
      ]);
      if (errors.length > 0) throw errors[0];

      const worklist = createDefaultWorklist(ast, environments);
      worklist.drain();

      const compiler = SVMLCompiler.fromProgramUnit(
        ast,
        environments,
        makeDfaQuery(worklist.locate, (id) => worklist.futureDispatchChainForNode(id)),
      );
      const program = compiler.compileProgram(ast);

      const dispatch = makeJitDispatch(worklist);
      const interpreter = new SVMLInterpreter(program, {
        sendOutput: msg => this.conductor.sendOutput(msg),
        // SVML policy is "always recompile": baseline and skip both re-lower
        // from `unit.funcAst.body`, because transforms may have mutated it
        // in place post-load. Only `specialized` passes a speculative body.
        dispatchCall: (scopeId, args) => {
          const r = dispatch.onCall(scopeId, args);
          if (r === undefined) return undefined;
          const body = r.kind === "specialized" ? r.body : undefined;
          return compiler.compileFunction(r.unit, body);
        },
        dispatchReturn: dispatch.onReturn,
      });

      const returnValue = interpreter.execute();
      this.conductor.sendResult(SVMLInterpreter.toJSValue(returnValue));
    } catch (e) {
      this.conductor.sendError(new EvaluatorError(e));
    }
  }
}
