import { BasicEvaluator } from "@sourceacademy/conductor/runner";
import { makeJitPass } from "../engines/svml/jit-pass";
import { SVMLCompiler } from "../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../engines/svml/svml-interpreter";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import { Worklist, makeDfaQuery, makeJitObservers } from "../specialization";
import { EvaluatorError } from "./errors";

/**
 * SVML evaluator with JIT specialization. After static convergence and
 * compile, runtime observations drive further transforms; each mutated
 * FunctionDef is recompiled and patched into the function table via
 * `jitPass` (see `engines/svml/jit-pass.ts`).
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
        makeDfaQuery(worklist.factStore, worklist.nodeIndex),
        worklist.registry,
      );
      const program = compiler.compileProgram(ast);

      const interpreter = new SVMLInterpreter(program, {
        sendOutput: this.conductor.sendOutput,
        ...makeJitObservers(worklist),
      });

      worklist.register(makeJitPass({ compiler, interpreter }));

      worklist.beginBatch();
      try {
        const returnValue = await interpreter.execute();
        this.conductor.sendResult(SVMLInterpreter.toJSValue(returnValue));
      } finally {
        worklist.endBatch();
      }
    } catch (e) {
      this.conductor.sendError(new EvaluatorError(e));
    }
  }
}
