import { BasicEvaluator } from "@sourceacademy/conductor/runner";
import { SVMLCompiler } from "../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../engines/svml/svml-interpreter";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import { SpecializationEngine } from "../specialization";
import { SVMLSwapStrategy } from "./svml-swap-strategy";
import { EvaluatorError } from "./errors";

/**
 * JIT-capable SVML evaluator. Converges the static specialization pipeline
 * once, compiles the program with stable per-function indices, wires the
 * interpreter to the engine's observation sink, installs the SVML state-delta
 * strategy, and runs. The engine's coordinator subscribes to worklist changes
 * and applies per-function deltas (whole-function recompile by default,
 * operand-level patches when the strategy emits them); the safepoint contract
 * (activateScope pinning) prevents patching a live frame.
 */
export class PySvmlJitEvaluator extends BasicEvaluator {
  async evaluateChunk(chunk: string): Promise<void> {
    try {
      const script = chunk + "\n";
      const ast = parse(script);
      const { errors, environments } = analyzeWithEnvironments(ast, script, 4);
      if (errors.length > 0) throw errors[0];

      const engine = SpecializationEngine.create(ast, environments);
      engine.converge();

      const compiler = SVMLCompiler.fromProgramUnit(ast, environments, engine.units);
      const program = compiler.compileProgram(ast);
      const interpreter = new SVMLInterpreter(program, {
        sendOutput: this.conductor.sendOutput,
        observationSink: engine.observationSink,
      });

      engine.installStrategy(new SVMLSwapStrategy(compiler, interpreter));

      const returnValue = await engine.run(ast, () => interpreter.execute());
      this.conductor.sendResult(SVMLInterpreter.toJSValue(returnValue));
    } catch (e) {
      this.conductor.sendError(new EvaluatorError(e));
    }
  }
}
