import { BasicEvaluator } from "@sourceacademy/conductor/runner";
import { SVMLCompiler } from "../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../engines/svml/svml-interpreter";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import { makeDfaQuery, makeJitObservers } from "../specialization";
import { createDefaultWorklist } from "../specialization/defaults";
import { bodyToCompile, dispatchValid } from "../specialization/framework/dispatch";
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

      const observers = makeJitObservers(worklist);
      const interpreter = new SVMLInterpreter(program, {
        sendOutput: msg => this.conductor.sendOutput(msg),
        dispatchCall: (scopeId, args) => {
          observers.observeScopeCall(scopeId);
          const unit = worklist.topology.unitOfFunctionId(scopeId);
          if (unit === undefined) return undefined;
          for (let i = 0; i < args.length; i++) {
            observers.observeParamEntry(scopeId, i, args[i]);
          }
          // Memoization and other transforms must fire before we read the
          // body they might have rewritten. Live sweep before each compile
          // keeps the bytecode consistent with transform publication.
          worklist.sweepTransforms();
          const chain = observers.currentChainFor(scopeId);
          const isRetired = (n: Parameters<typeof worklist.isRetired>[0]) => worklist.isRetired(n);
          // SVML policy is "always recompile": even when dispatch is
          // invalid we re-lower the baseline body, because transforms
          // (memoization, dead-branch, etc.) may have mutated
          // unit.funcAst.body in place post-load. The explicit
          // dispatchValid branch surfaces the policy asymmetry that
          // was previously hidden inside an `undefined` overload.
          const body = dispatchValid(unit, chain, isRetired)
            ? bodyToCompile(unit, chain, worklist.topology, isRetired)
            : undefined;
          return compiler.compileFunction(unit, body);
        },
        dispatchReturn: (scopeId, value) => observers.observeScopeReturn(scopeId, value),
      });

      const returnValue = interpreter.execute();
      this.conductor.sendResult(SVMLInterpreter.toJSValue(returnValue));
    } catch (e) {
      this.conductor.sendError(new EvaluatorError(e));
    }
  }
}
