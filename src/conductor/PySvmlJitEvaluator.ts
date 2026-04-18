import { BasicEvaluator } from "@sourceacademy/conductor/runner";
import { SpeculationViolation } from "../engines/svml/errors";
import { makeJitAnalysis } from "../engines/svml/jit-analysis";
import { SVMLCompiler } from "../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../engines/svml/svml-interpreter";
import type { SVMLBoxType } from "../engines/svml/types";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import {
  Worklist,
  makeJitObservers,
  makeDfaQuery,
  blacklistSpeculation,
} from "../specialization";
import { EvaluatorError } from "./errors";

/** Cap on consecutive deopts before giving up. A speculation that violates
 *  on every retry indicates a bug in the speculative analysis or in our widening
 *  protocol — running forever would just hang. */
const MAX_DEOPT_RETRIES = 32;

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
        makeDfaQuery(worklist.factStore, worklist.nodeIndex),
        worklist.registry,
      );
      const program = compiler.compileProgram(ast);

      const interpreter = new SVMLInterpreter(program, {
        sendOutput: this.conductor.sendOutput,
        ...makeJitObservers(worklist),
      });

      worklist.register(makeJitAnalysis({ compiler, interpreter }));

      worklist.beginBatch();
      try {
        const returnValue = await runWithDeopt(interpreter, worklist);
        this.conductor.sendResult(SVMLInterpreter.toJSValue(returnValue));
      } finally {
        worklist.endBatch();
      }
    } catch (e) {
      this.conductor.sendError(new EvaluatorError(e));
    }
  }
}

/** Drive `interpreter.execute()` with deopt-and-retry. On `SpeculationViolation`,
 *  widen the observation that was speculated on; the worklist's cascading
 *  edges (runtimeWriteAnalysis → speculative analyses → jit-analysis) then drain a
 *  recompile-and-patch before the next retry. Bounded by `MAX_DEOPT_RETRIES`
 *  to avoid infinite loops on a buggy speculator. */
async function runWithDeopt(
  interpreter: SVMLInterpreter,
  worklist: Worklist,
): Promise<SVMLBoxType> {
  let attempts = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await interpreter.execute();
    } catch (e) {
      if (!(e instanceof SpeculationViolation)) throw e;
      if (++attempts > MAX_DEOPT_RETRIES) {
        throw new Error(
          `JIT deopt budget exhausted (${MAX_DEOPT_RETRIES}); last violation at node ${e.nodeId} (${e.witnessedKind})`,
        );
      }
      blacklistSpeculation(worklist, e.nodeId);
      // observe() drains automatically when batchDepth permits; inside
      // beginBatch we need to drain explicitly so jit-analysis.transfer fires
      // and patches the function table before retry.
      worklist.drain();
    }
  }
}
