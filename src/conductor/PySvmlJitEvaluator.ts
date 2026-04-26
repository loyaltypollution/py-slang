import { BasicEvaluator } from "@sourceacademy/conductor/runner";
import { SVMLCompiler } from "../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../engines/svml/svml-interpreter";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import { createDefaultWorklist, makeJitDispatch } from "../specialization";
import { constAnalysis, typeAnalysis } from "../specialization/analysis";
import { ROOT_CONTEXT } from "../specialization/assumption/chain";
import math from "../stdlib/math";
import memo from "../stdlib/memo";
import misc from "../stdlib/misc";
import { EvaluatorError } from "./errors";

/**
 * SVML evaluator with JIT specialization — V2 collapse.
 *
 * No dispatch tree, no IR cache, no deopt path. Each CALL goes through
 * `dispatchCall`: observe runtime events, derive the specialized body under
 * the resulting (live-correct) chain, compile to fresh SVMLIR, return it
 * for this one invocation. Precision drift is impossible by construction:
 * the chain the body was pruned under is the same chain the arguments
 * produced a moment ago.
 *
 * Publication: this evaluator IS the `PublicationStrategy` (see
 * `specialization/publication.ts`). The artifact (`SVMLIR`) is captured
 * directly into the new call frame and never installed back into
 * `SVMLProgram` — the only swap channel is the next-call dispatch.
 *
 * Symmetric with `PyCseJitEvaluator.dispatchCall`, modulo the final
 * `compiler.compileFunction` step that lowers the chosen body to bytecode.
 */
export class PySvmlJitEvaluator extends BasicEvaluator {
  async evaluateChunk(chunk: string): Promise<void> {
    try {
      const script = chunk + "\n";
      const ast = parse(script);
      const { errors, environments } = analyzeWithEnvironments(ast, script, 4, [misc, math, memo]);
      if (errors.length > 0) throw errors[0];

      const worklist = createDefaultWorklist(ast, environments);
      worklist.drain();

      // SVML compiler only reads ROOT-context static facts. Per-call
      // speculative bodies arrive pre-pruned via compileFunction(unit, body).
      const typeStore = typeAnalysis.perExpr(worklist.locate);
      const constStore = constAnalysis.perExpr(worklist.locate);
      const compiler = SVMLCompiler.fromProgramUnit(ast, environments, {
        typeOf: id => typeStore.tryRead(id, ROOT_CONTEXT),
        constOf: id => constStore.tryRead(id, ROOT_CONTEXT),
      });
      const program = compiler.compileProgram(ast);

      const dispatch = makeJitDispatch(worklist);
      const interpreter = new SVMLInterpreter(program, {
        sendOutput: msg => this.conductor.sendOutput(msg),
        // SVML policy is "always recompile": baseline and skip both re-lower
        // from `unit.funcAst.body`, because transforms may have mutated it
        // in place post-load. Only `specialized` passes a speculative body.
        dispatchCall: (scopeId, args) => {
          const plan = dispatch.onCall(scopeId, args);
          if (plan === undefined) return undefined;
          return compiler.compileFunction(plan.unit, plan.body);
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
