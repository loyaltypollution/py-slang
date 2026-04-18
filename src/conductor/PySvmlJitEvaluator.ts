import { BasicEvaluator } from "@sourceacademy/conductor/runner";
import { makeJitAnalysis } from "../engines/svml/jit-analysis";
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
 * `jitAnalysis` (see `engines/svml/jit-analysis.ts`).
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
          worklist.factStore,
          worklist.nodeIndex,
          nodeId => worklist.specContextForNode(nodeId),
        ),
        worklist.registry,
        worklist,
      );
      const program = compiler.compileProgram(ast);

      const interpreter = new SVMLInterpreter(program, {
        sendOutput: this.conductor.sendOutput,
        ...makeJitObservers(worklist),
      });

      const jitAnalysis = makeJitAnalysis({
        compiler,
        interpreter,
        specContextFor: unit => worklist.specContextFor(unit),
      });
      worklist.register(jitAnalysis);

      worklist.beginBatch();
      try {
        const returnValue = await runWithDeopt(() => interpreter.execute(), worklist);
        this.conductor.sendResult(SVMLInterpreter.toJSValue(returnValue));
      } finally {
        worklist.endBatch();
      }
    } catch (e) {
      this.conductor.sendError(new EvaluatorError(e));
    }
  }
}
