import { BasicEvaluator } from "@sourceacademy/conductor/runner";
import { SVMLCompiler } from "../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../engines/svml/svml-interpreter";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import {
  ConstAnalysisPass,
  ConstantFoldingRule,
  MemoizationTransformRule,
  Worklist,
  TypeAnalysisPass,
} from "../specialization";
import { EvaluatorError } from "./errors";

export class PySvmlEvaluator extends BasicEvaluator {
  evaluateChunk(chunk: string): Promise<void> {
    try {
      const script = chunk + "\n";
      const ast = parse(script);
      const { errors, environments } = analyzeWithEnvironments(ast, script, 4);
      if (errors.length > 0) {
        throw errors[0];
      }
      const worklist = new Worklist(
        ast,
        environments,
        [new TypeAnalysisPass(), new ConstAnalysisPass()],
        [
          new ConstantFoldingRule(),
          new MemoizationTransformRule(),
        ],
        [],
      );
      worklist.converge();
      const compiler = SVMLCompiler.fromProgramUnit(ast, environments, worklist.units);
      const program = compiler.compileProgram(ast);
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
