import { BasicEvaluator } from "@sourceacademy/conductor/runner";
import { SVMLCompiler } from "../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../engines/svml/svml-interpreter";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import { makeDfaQuery } from "../specialization";
import { createDefaultWorklist } from "../specialization/defaults";
import { makeJitDispatch } from "../specialization/framework/jit-dispatch";
import { EvaluatorError } from "./errors";

/**
 * SVML evaluator with JIT specialization — V2 collapse.
 *
 * No dispatch tree, no IR cache, no deopt path. Each CALL goes through
 * `dispatchCall`: publish observations, derive the specialized body under
 * the resulting (live-correct) chain, compile to fresh SVMLIR, return it
 * for this one invocation. Precision drift is impossible by construction:
 * the chain the body was pruned under is the same chain the arguments
 * produced a moment ago.
 *
 * Symmetric with `PyCseJitEvaluator.dispatchCall`, modulo the final
 * `compiler.compileFunction` step that lowers the chosen body to bytecode.
 */
export class PySvmlJitEvaluator extends BasicEvaluator {
  async evaluateChunk(chunk: string): Promise<void> {
    try {
      const script = chunk + "\n";
      const ast = parse(script);
      const { errors, environments } = analyzeWithEnvironments(ast, script, 4);
      if (errors.length > 0) throw errors[0];

      const worklist = createDefaultWorklist(ast, environments);
      worklist.drain();

      const compiler = SVMLCompiler.fromProgramUnit(
        ast,
        environments,
        makeDfaQuery(
          worklist.topology,
          nodeId => worklist.futureDispatchChainForNode(nodeId),
          unit => worklist.futureDispatchChainFor(unit),
        ),
        worklist.registry,
      );
      const program = compiler.compileProgram(ast);

      const dispatch = makeJitDispatch(worklist);
      const interpreter = new SVMLInterpreter(program, {
        sendOutput: msg => this.conductor.sendOutput(msg),
        // SVML policy is "always recompile": baseline and skip both re-lower
        // from `unit.funcAst.body`, because transforms may have mutated it
        // in place post-load. Only `specialized` passes a speculative body.
        dispatchCall: (scopeId, args) => {
          const r = dispatch.onCall(scopeId, args);
          if (r === undefined) return undefined;
          const body = r.kind === "specialized" ? r.body : undefined;
          return compiler.compileFunction(r.unit, body);
        },
        dispatchReturn: dispatch.onReturn,
      });

      const returnValue = interpreter.execute();
      this.conductor.sendResult(SVMLInterpreter.toJSValue(returnValue));
    } catch (e) {
      this.conductor.sendError(new EvaluatorError(e));
    }
  }
}
