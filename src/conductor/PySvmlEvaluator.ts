import { BasicEvaluator } from "@sourceacademy/conductor/runner";
import { SVMLCompiler } from "../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../engines/svml/svml-interpreter";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import { buildFunctionUnits } from "../specialization";
import { Db, astOf, environmentsOf } from "../specialization/runtime";
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
      // Populate the query-runtime Inputs the SVMLCompiler's typeOf/constOf
      // reads depend on. unitMap is built inline (pure structural helper)
      // since the Worklist no longer exists to own it.
      const db = new Db();
      astOf.set(db, 0, ast);
      environmentsOf.set(db, 0, environments);
      const units = buildFunctionUnits(ast, environments);
      const compiler = SVMLCompiler.fromProgramUnit(ast, environments, units, db);
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
