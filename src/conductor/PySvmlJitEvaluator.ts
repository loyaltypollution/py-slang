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
