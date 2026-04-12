import { BasicEvaluator } from "@sourceacademy/conductor/runner";
import { SVMLCompiler } from "../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../engines/svml/svml-interpreter";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import {
  ConstAnalysisModule,
  ConstantFoldingRule,
  DeadBranchEliminationRule,
  CallCountObserver,
  MemoizationTransformRule,
  OSRCoordinator,
  PersistentWorklist,
  runPinned,
  TypeAnalysisModule,
} from "../specialization";
import { SVMLSwapStrategy } from "./svml-swap-strategy";
import { EvaluatorError } from "./errors";

/**
 * JIT-capable SVML evaluator. Converges the static specialization pipeline
 * once, compiles the program with stable per-function indices, wires the
 * interpreter to the worklist's observation sink, installs the SVML
 * state-delta strategy via an OSRCoordinator, and runs inside a pinned
 * root scope. The coordinator subscribes to worklist changes and applies
 * per-function deltas (whole-function recompile by default, operand-level
 * patches when the strategy emits them); the safepoint contract
 * (activateScope pinning) prevents patching a live frame.
 */
export class PySvmlJitEvaluator extends BasicEvaluator {
  async evaluateChunk(chunk: string): Promise<void> {
    try {
      const script = chunk + "\n";
      const ast = parse(script);
      const { errors, environments } = analyzeWithEnvironments(ast, script, 4);
      if (errors.length > 0) throw errors[0];

      const worklist = new PersistentWorklist(
        ast,
        environments,
        [new TypeAnalysisModule(), new ConstAnalysisModule()],
        [new DeadBranchEliminationRule(), new ConstantFoldingRule(), new MemoizationTransformRule()],
      );
      worklist.addCallObserver(new CallCountObserver());
      worklist.converge();

      const compiler = SVMLCompiler.fromProgramUnit(ast, environments, worklist.units);
      const program = compiler.compileProgram(ast);
      const interpreter = new SVMLInterpreter(program, {
        sendOutput: this.conductor.sendOutput,
        observationSink: worklist,
      });

      const coordinator = new OSRCoordinator(
        worklist,
        new SVMLSwapStrategy(compiler, interpreter),
      );

      const returnValue = await runPinned(worklist, coordinator, ast, () =>
        interpreter.execute(),
      );
      this.conductor.sendResult(SVMLInterpreter.toJSValue(returnValue));
    } catch (e) {
      this.conductor.sendError(new EvaluatorError(e));
    }
  }
}
