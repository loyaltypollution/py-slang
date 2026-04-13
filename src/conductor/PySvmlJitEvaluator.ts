import { BasicEvaluator } from "@sourceacademy/conductor/runner";
import { StmtNS } from "../ast-types";
import { SVMLCompiler } from "../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../engines/svml/svml-interpreter";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import {
  CallCountScopePass,
  ConstAnalysisPass,
  ConstantFoldingRule,
  DeadBranchEliminationRule,
  MemoizationTransformRule,
  PurityEffectAnalysis,
  PurityScopePass,
  TypeAnalysisPass,
  Worklist,
} from "../specialization";
import { EvaluatorError } from "./errors";

/**
 * SVML evaluator with JIT specialization. After static convergence and
 * compile, runtime observations drive further transforms; each mutated
 * FunctionDef is recompiled and patched into the function table via
 * `onScopeChanged`.
 */
export class PySvmlJitEvaluator extends BasicEvaluator {
  async evaluateChunk(chunk: string): Promise<void> {
    try {
      const script = chunk + "\n";
      const ast = parse(script);
      const { errors, environments } = analyzeWithEnvironments(ast, script, 4);
      if (errors.length > 0) throw errors[0];

      const worklist = new Worklist(
        ast,
        environments,
        [new TypeAnalysisPass(), new ConstAnalysisPass(), new PurityEffectAnalysis()],
        [
          new DeadBranchEliminationRule(),
          new ConstantFoldingRule(),
          new MemoizationTransformRule(),
        ],
        [new CallCountScopePass(), new PurityScopePass()],
      );
      worklist.converge();

      const compiler = SVMLCompiler.fromProgramUnit(ast, environments, worklist.units);
      const program = compiler.compileProgram(ast);
      const interpreter = new SVMLInterpreter(program, {
        sendOutput: this.conductor.sendOutput,
        observationSink: worklist,
      });

      worklist.onScopeChanged((scope, unit) => {
        // Only FunctionDef scopes are hot-swappable — skip FileInput.
        if (!(scope instanceof StmtNS.FunctionDef)) return;
        const index = compiler.indexOf(scope);
        if (index === undefined) return;
        interpreter.patchFunction(index, compiler.compileFunction(unit));
      });

      const returnValue = await interpreter.execute();
      worklist.tick();
      this.conductor.sendResult(SVMLInterpreter.toJSValue(returnValue));
    } catch (e) {
      this.conductor.sendError(new EvaluatorError(e));
    }
  }
}
