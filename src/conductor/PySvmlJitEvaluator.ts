import { BasicEvaluator } from "@sourceacademy/conductor/runner";
import { SVMLCompiler } from "../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../engines/svml/svml-interpreter";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import { createReactiveOptimization } from "../specialization/reactive";
import { EvaluatorError } from "./errors";

/**
 * JIT-capable SVML evaluator using the reactive optimization API.
 *
 * Uses createReactiveOptimization + converge() for the initial static pass,
 * then wires a subscription that recompiles changed functions and swaps the
 * program into the interpreter via replaceProgram(). The subscription fires
 * on subsequent tick() calls (future use for runtime-driven re-optimization).
 */
export class PySvmlJitEvaluator extends BasicEvaluator {
  evaluateChunk(chunk: string): Promise<void> {
    try {
      const script = chunk + "\n";
      const ast = parse(script);
      const { errors, environments } = analyzeWithEnvironments(ast, script, 4);
      if (errors.length > 0) {
        throw errors[0];
      }

      // Reactive path: create optimization + converge (initial static pass)
      const reactive = createReactiveOptimization(ast, environments);
      reactive.converge();

      const compiler = SVMLCompiler.fromProgramUnit(ast, environments, reactive.units);
      const program = compiler.compileProgram(ast);

      const scopeMap = compiler.scopeIndexMap;
      let currentProgram = program;

      const interpreter = new SVMLInterpreter(currentProgram, {
        sendOutput: this.conductor.sendOutput,
      });

      reactive.subscribe(changed => {
        // Recompile entire program to get fresh IR
        const freshCompiler = SVMLCompiler.fromProgramUnit(ast, environments, reactive.units);
        const freshProgram = freshCompiler.compileProgram(ast);

        // Extract only the changed functions' IR
        for (const key of changed) {
          const idx = scopeMap?.getIndex(key);
          if (idx !== undefined) {
            currentProgram = currentProgram.withSpecializedFunction(idx, freshProgram.functions[idx]);
          }
        }
        interpreter.replaceProgram(currentProgram);
      });

      const returnValue = interpreter.execute();
      this.conductor.sendResult(SVMLInterpreter.toJSValue(returnValue));
    } catch (e) {
      this.conductor.sendError(new EvaluatorError(e));
    }
    return Promise.resolve();
  }
}
