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
        const returnValue = await runWithDeopt(interpreter, worklist, jitAnalysis);
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
 *  retract the offending unit's speculation by collapsing its context to
 *  ROOT (see `Worklist.widenUnitSpeculation`). A pure context reset advances
 *  no facts, so `jitAnalysis` is enqueued explicitly for the unit; on the
 *  subsequent drain, `jitAnalysis.transfer` observes `specContext` shifted
 *  to ROOT, recompiles without guards, and patches the function table.
 *  Bounded by `MAX_DEOPT_RETRIES` to avoid infinite loops on a buggy
 *  speculator. */
async function runWithDeopt(
  interpreter: SVMLInterpreter,
  worklist: Worklist,
  jitAnalysis: Parameters<Worklist["enqueue"]>[0],
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
      const unit = worklist.widenGuard(e.nodeId);
      if (unit !== undefined) worklist.enqueue(jitAnalysis, unit);
      // observe() drains automatically when batchDepth permits; inside
      // beginBatch we need to drain explicitly so jit-analysis.transfer fires
      // and patches the function table before retry.
      worklist.drain();
    }
  }
}
