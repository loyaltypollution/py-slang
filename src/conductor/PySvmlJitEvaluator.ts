import { BasicEvaluator } from "@sourceacademy/conductor/runner";
import { makeJitAnalysis } from "./svml-jit-analysis";
import { SVMLCompiler } from "../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../engines/svml/svml-interpreter";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import {
  Worklist,
  makeJitObservers,
  makeDfaQuery,
} from "../specialization";
import { EvaluatorError } from "./errors";
import { runWithDeopt } from "./jit-deopt";

/**
 * SVML evaluator with JIT specialization. After static convergence and
 * compile, runtime observations drive further transforms; each mutated
 * FunctionDef is recompiled and patched into the function table via
 * `jitAnalysis` (see `./svml-jit-analysis.ts`).
 */
export class PySvmlJitEvaluator extends BasicEvaluator {
  async evaluateChunk(chunk: string): Promise<void> {
    try {
      const script = chunk + "\n";
      const ast = parse(script);
      const { errors, environments } = analyzeWithEnvironments(ast, script, 4);
      if (errors.length > 0) throw errors[0];

      const worklist = new Worklist(ast, environments);
      worklist.drain();

      const compiler = SVMLCompiler.fromProgramUnit(
        ast,
        environments,
        makeDfaQuery(
          worklist.topology,
          nodeId => worklist.specAssumptionChainForNode(nodeId),
          unit => worklist.specAssumptionChainFor(unit),
        ),
        worklist.registry,
        worklist,
      );
      const program = compiler.compileProgram(ast);

      const interpreter = new SVMLInterpreter(program, {
        sendOutput: msg => this.conductor.sendOutput(msg),
        ...makeJitObservers(worklist),
      });

      const jitAnalysis = makeJitAnalysis({
        compiler,
        interpreter,
        specAssumptionChainFor: unit => worklist.specAssumptionChainFor(unit),
      });
      worklist.register(jitAnalysis);

      const returnValue = await runWithDeopt(() => interpreter.execute(), worklist);
      this.conductor.sendResult(SVMLInterpreter.toJSValue(returnValue));
    } catch (e) {
      this.conductor.sendError(new EvaluatorError(e));
    }
  }
}
