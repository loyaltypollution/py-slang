import { BasicEvaluator } from "@sourceacademy/conductor/runner";
import { SVMLCompiler } from "../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../engines/svml/svml-interpreter";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import { createReactiveOptimization } from "../specialization";
import { EvaluatorError } from "./errors";

/**
 * JIT-capable SVML evaluator. Runs initial static optimization to fixpoint,
 * then compiles and executes. The subscribe → recompile → replaceProgram()
 * hot-swap glue is not wired here; `replaceProgram()` itself is covered by
 * `interpreter-replace-program.test.ts`.
 */
export class PySvmlJitEvaluator extends BasicEvaluator {
  evaluateChunk(chunk: string): Promise<void> {
    try {
      const script = chunk + "\n";
      const ast = parse(script);
      const { errors, environments } = analyzeWithEnvironments(ast, script, 4);
      if (errors.length > 0) throw errors[0];

      const reactive = createReactiveOptimization(ast, environments);
      reactive.converge();

      const compiler = SVMLCompiler.fromProgramUnit(ast, environments, reactive.units);
      const program = compiler.compileProgram(ast);
      const interpreter = new SVMLInterpreter(program, { sendOutput: this.conductor.sendOutput });

      const returnValue = interpreter.execute();
      this.conductor.sendResult(SVMLInterpreter.toJSValue(returnValue));
    } catch (e) {
      this.conductor.sendError(new EvaluatorError(e));
    }
    return Promise.resolve();
  }
}
