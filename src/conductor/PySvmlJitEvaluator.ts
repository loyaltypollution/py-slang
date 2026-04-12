import { BasicEvaluator } from "@sourceacademy/conductor/runner";
import { SVMLCompiler } from "../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../engines/svml/svml-interpreter";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import { createReactiveOptimization, OSRCoordinator } from "../specialization";
import { SVMLSwapStrategy } from "./svml-swap-strategy";
import { EvaluatorError } from "./errors";

/**
 * JIT-capable SVML evaluator. Converges the static reactive-optimization
 * pipeline once, compiles the program with stable per-function indices, and
 * runs the interpreter with an `observationSink` wired into the worklist.
 * An `OSRCoordinator` subscribes to worklist changes and patches individual
 * function IRs in place whenever runtime observations trigger additional
 * transforms. The worklist's `activateScope` pinning supplies the safepoint
 * contract that prevents patching a frame that is currently on the stack.
 */
export class PySvmlJitEvaluator extends BasicEvaluator {
  async evaluateChunk(chunk: string): Promise<void> {
    try {
      const script = chunk + "\n";
      const ast = parse(script);
      const { errors, environments } = analyzeWithEnvironments(ast, script, 4);
      if (errors.length > 0) throw errors[0];

      const reactive = createReactiveOptimization(ast, environments);
      reactive.converge();

      const compiler = SVMLCompiler.fromProgramUnit(ast, environments, reactive.units);
      const program = compiler.compileProgram(ast);
      const interpreter = new SVMLInterpreter(program, {
        sendOutput: this.conductor.sendOutput,
        observationSink: reactive,
      });

      const coord = new OSRCoordinator(reactive, new SVMLSwapStrategy(compiler, interpreter));
      const stop = coord.start();
      try {
        const returnValue = await reactive.withActiveScope(ast, () => interpreter.execute());
        this.conductor.sendResult(SVMLInterpreter.toJSValue(returnValue));
      } finally {
        stop();
      }
    } catch (e) {
      this.conductor.sendError(new EvaluatorError(e));
    }
  }
}
