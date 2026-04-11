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
 * Currently functionally identical to PySvmlEvaluator — uses
 * createReactiveOptimization + converge() which is equivalent to the
 * one-shot optimize() path. The reactive infrastructure is wired up
 * but subscription-based recompilation is deferred until Gap 2
 * (interpreter program swap) is implemented.
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

      // TODO: subscribe to reactive changes for recompilation
      // const scopeMap = compiler.scopeIndexMap;
      // reactive.subscribe(changed => {
      //   const newProgram = recompileChanged(program, changed, scopeMap, reactive.units);
      //   interpreter.replaceProgram(newProgram);  // Gap 2
      // });

      const interpreter = new SVMLInterpreter(program, {
        sendOutput: this.conductor.sendOutput,
      });
      const returnValue = interpreter.execute();
      this.conductor.sendResult(SVMLInterpreter.toJSValue(returnValue));
    } catch (e) {
      this.conductor.sendError(new EvaluatorError(e));
    }
    return Promise.resolve();
  }
}
