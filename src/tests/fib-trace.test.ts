import { StmtNS } from "../ast-types";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import { buildTestWorklist } from "./utils";
import { SVMLCompiler } from "../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../engines/svml/svml-interpreter";
import {
  callCountPass,
  purityScopePass,
  structuralPass,
} from "../specialization";
import { typeAnalysisPass } from "../specialization/type-analysis/analysis";
import { runtimeCallPass, runtimeWritePass } from "../specialization/framework/runtime-passes";
import type { Pass, PassCtx } from "../specialization/framework/pass";

test("fib(20) trace through specialization + SVML", () => {
  const code = `
def fib(n):
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)

fib(20)
`;
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const reactive = buildTestWorklist(ast, environments);

  const log: string[] = [];
  log.push("== Phase 1: static converge ==");
  reactive.converge();

  const fibDef = ast.statements.find(
    (s): s is StmtNS.FunctionDef =>
      s instanceof StmtNS.FunctionDef && s.name.lexeme === "fib",
  )!;
  const fibUnit = reactive.units.get(fibDef)!;

  log.push(`  structuralPass[fib-unit] = ${reactive.factStore.tryRead(structuralPass, fibUnit)}`);
  log.push(`  purityScopePass[fib-scope] = ${reactive.factStore.tryRead(purityScopePass, fibDef.id)}`);
  log.push(`  callCountPass[fib-scope] pre = ${reactive.factStore.tryRead(callCountPass, fibDef.id)}`);

  let typeHits = 0;
  for (const v of reactive.factStore.readAll(typeAnalysisPass).values()) {
    if (v !== undefined) typeHits++;
  }
  log.push(`  typeAnalysisPass populated cells: ${typeHits}`);

  log.push("== Phase 2: compile ==");
  const compiler = SVMLCompiler.fromProgramUnit(
    ast,
    environments,
    reactive.units,
    reactive.factStore,
  );
  const program = compiler.compileProgram(ast);
  const fibIdx = compiler.indexOf(fibDef);
  log.push(`  fib stable index = ${fibIdx}`);
  log.push(`  program functions = ${program.functions.length}`);

  log.push("== Phase 3: execute + observe ==");
  const interpreter = new SVMLInterpreter(program);
  (interpreter as any).observeNodeWrite = (id: number, v: unknown) => {
    reactive.observe(runtimeWritePass, id, v);
  };
  (interpreter as any).observeScopeCall = (scopeId: number) => {
    const prev = reactive.factStore.tryRead(runtimeCallPass, scopeId) ?? 0;
    reactive.observe(runtimeCallPass, scopeId, prev + 1);
  };

  const patchLog: number[] = [];
  const origPatch = interpreter.patchFunction.bind(interpreter);
  interpreter.patchFunction = (idx: number, ir: any) => {
    patchLog.push(idx);
    return origPatch(idx, ir);
  };

  const jitPass: Pass<StmtNS.FunctionDef | StmtNS.FileInput, number> = {
    id: Symbol("jitPass-trace"),
    debugName: "jitPass-trace",
    lattice: { bottom: 0, equals: (a, b) => a === b, join: (a, b) => Math.max(a, b) },
    reads: [callCountPass, purityScopePass, structuralPass],
    tier: "transform",
    affectedKeys(_ctx, _triggerPass, _triggerKey) {
      const keys: (StmtNS.FunctionDef | StmtNS.FileInput)[] = [];
      for (const scope of reactive.units.keys()) {
        if (scope instanceof StmtNS.FunctionDef) keys.push(scope);
      }
      return keys;
    },
    transfer(_ctx: PassCtx, scope): number | undefined {
      if (!(scope instanceof StmtNS.FunctionDef)) return undefined;
      const unit = reactive.units.get(scope);
      if (!unit) return undefined;
      const idx = compiler.indexOf(scope);
      if (idx === undefined) return undefined;
      const newIR = compiler.compileFunction(unit);
      interpreter.patchFunction(idx, newIR);
      return unit.generation + 1;
    },
  };
  reactive.register(jitPass);

  const result = interpreter.execute();
  log.push(`  fib(20) result = ${result}`);
  log.push(`  callCountPass[fib-scope] post = ${reactive.factStore.tryRead(callCountPass, fibDef.id)}`);
  log.push(`  runtimeCallPass[fib-scope] = ${reactive.factStore.tryRead(runtimeCallPass, fibDef.id)}`);
  log.push(`  patchFunction calls = ${patchLog.length}`);

  // eslint-disable-next-line no-console
  console.log(log.join("\n"));

  expect(result).toBe(6765);
});
