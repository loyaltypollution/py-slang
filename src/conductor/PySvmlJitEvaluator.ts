import { BasicEvaluator } from "@sourceacademy/conductor/runner";
import { SVMLCompiler } from "../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../engines/svml/svml-interpreter";
import { makeJitPass } from "../engines/svml/jit-pass";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import { Worklist, runtimeCallPass, runtimeWritePass } from "../specialization";
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
      worklist.converge();

      const compiler = SVMLCompiler.fromProgramUnit(ast, environments, worklist.units, worklist.factStore);
      const program = compiler.compileProgram(ast);

      // Per-callee raw count map for runtimeCallPass.
      const callCounts = new Map<number, number>();

      const interpreter = new SVMLInterpreter(program, {
        sendOutput: this.conductor.sendOutput,
        observeNodeWrite: (nodeId, value) => {
          worklist.observe(runtimeWritePass, nodeId, value);
        },
        observeScopeCall: (scopeId) => {
          const next = (callCounts.get(scopeId) ?? 0) + 1;
          callCounts.set(scopeId, next);
          worklist.observe(runtimeCallPass, scopeId, next);
        },
      });

      worklist.register(makeJitPass({
        compiler,
        interpreter,
        unitsOf: () => worklist.units.values(),
      }));

      const returnValue = await interpreter.execute();
      this.conductor.sendResult(SVMLInterpreter.toJSValue(returnValue));
    } catch (e) {
      this.conductor.sendError(new EvaluatorError(e));
    }
  }
}
