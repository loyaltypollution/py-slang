import { BasicEvaluator } from "@sourceacademy/conductor/runner";
import { StmtNS } from "../ast-types";
import { SVMLCompiler } from "../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../engines/svml/svml-interpreter";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments, FunctionEnvironments } from "../resolver";
import { buildFunctionUnits } from "../specialization";
import {
  Db,
  astOf,
  environmentsOf,
  optimizedLoweredOf,
  runtimeCall,
  runtimeWrite,
} from "../specialization/runtime";
import { EvaluatorError } from "./errors";

/**
 * SVML evaluator with JIT specialization. Recompile is driven by a
 * synchronous pull on `optimizedAstOf` at every observed CALL: when the
 * lowering chain produces a new AST reference, the unit is recompiled
 * and every function slot is patched. AST identity *is* the recompile
 * digest — `optimizedAstOf`'s lattice equals on `===`, so a green
 * recomputation snaps the cell without producing a new reference.
 *
 * Whole-unit recompile (option A): the query cache is unit-granular, so
 * we mirror that here. Per-function diff/patch is a future optimization
 * (5b follow-up if the JIT end-to-end test regresses materially).
 */
export class PySvmlJitEvaluator extends BasicEvaluator {
  private db: Db = new Db();
  private lastCompiledAst: StmtNS.FileInput | undefined = undefined;

  async evaluateChunk(chunk: string): Promise<void> {
    try {
      const script = chunk + "\n";
      const ast = parse(script);
      const { errors, environments } = analyzeWithEnvironments(ast, script, 4);
      if (errors.length > 0) throw errors[0];

      // Per-chunk Db; lastCompiledAst tracks reference-identity of the
      // most recently compiled lowered AST so the synchronous pull below
      // can detect "did anything change".
      this.db = new Db();
      this.lastCompiledAst = ast;
      astOf.set(this.db, 0, ast);
      environmentsOf.set(this.db, 0, environments);

      // unitMap is a pure structural helper; no Worklist needed.
      const units = buildFunctionUnits(ast, environments);

      const compiler = SVMLCompiler.fromProgramUnit(
        ast,
        environments,
        units,
        this.db,
      );
      const program = compiler.compileProgram(ast);

      const callCounts = new Map<number, number>();

      const interpreter = new SVMLInterpreter(program, {
        sendOutput: this.conductor.sendOutput,
        observeNodeWrite: (nodeId, value) => {
          runtimeWrite.set(this.db, nodeId, value);
        },
        observeScopeCall: (scopeId) => {
          const next = (callCounts.get(scopeId) ?? 0) + 1;
          callCounts.set(scopeId, next);
          runtimeCall.set(this.db, scopeId, next);

          // Pull the current lowered unit. Cache + lattice-equals make
          // this O(1) once the unit has saturated.
          const lowered = this.db.get(optimizedLoweredOf, 0);
          if (lowered !== undefined && lowered.ast !== this.lastCompiledAst) {
            this.lastCompiledAst = lowered.ast;
            this.recompileAndPatch(lowered.ast, lowered.environments, interpreter);
          }
        },
      });

      const returnValue = await interpreter.execute();
      this.conductor.sendResult(SVMLInterpreter.toJSValue(returnValue));
    } catch (e) {
      this.conductor.sendError(new EvaluatorError(e));
    }
  }

  /**
   * Whole-unit recompile + patch every function slot. The lowering chain
   * already threaded an extended `environments` map covering the
   * memoize-synthesized FunctionDef nodes, so the resolver does not need
   * to run again.
   *
   * `patchFunction` is safe to call mid-execution: it only rewrites the
   * function-table slot. Live `CallFrame.ir` references captured at CALL
   * time drain on the old IR; future CALLs dispatch through the patched
   * slot.
   */
  private recompileAndPatch(
    ast: StmtNS.FileInput,
    environments: FunctionEnvironments,
    interpreter: SVMLInterpreter,
  ): void {
    // Throwaway Db: the recompile runs on a lowered AST whose node ids no
    // longer match analysis facts in `this.db`, so specialization hints
    // fall back to BOTTOM (safe, generic opcodes) — exactly what we want.
    const rebuildDb = new Db();
    astOf.set(rebuildDb, 0, ast);
    environmentsOf.set(rebuildDb, 0, environments);
    const newCompiler = SVMLCompiler.fromProgram(ast, rebuildDb, environments);
    const newProgram = newCompiler.compileProgram(ast);
    for (let i = 0; i < newProgram.functions.length; i++) {
      interpreter.patchFunction(i, newProgram.functions[i]);
    }
  }
}
