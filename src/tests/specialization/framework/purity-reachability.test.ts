// Purity analysis should become `true` under a speculation context that
// prunes all impure blocks. Before the reachability fix in
// purityScopeAnalysis.transfer, impure blocks contributed their sentinel
// regardless of whether they were reachable — Collatz-style bodies stayed
// impure under every context.

import { StmtNS } from "../../../ast-types";
import { parse } from "../../../parser/parser-adapter";
import { analyzeWithEnvironments } from "../../../resolver";
import { purityScopeAnalysis } from "../../../specialization/purity-analysis/analysis";
import { runtimeParamAnalysis } from "../../../specialization/framework/runtime-analyses";
import { paramKey } from "../../../specialization/framework/key-spaces";
import { ROOT_CONTEXT } from "../../../specialization/framework/context";
import { buildTestWorklist } from "../../utils";

function build(code: string) {
  const script = code + "\n";
  const ast = parse(script);
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const worklist = buildTestWorklist(ast, environments);
  worklist.drain();
  return { ast, worklist };
}

describe("purityScopeAnalysis reachability", () => {
  test("Collatz: purity is false at ROOT, true under x:pos-int speculation", () => {
    // The true branch of `if x <= 0` is impure (calls print). Under ROOT,
    // purity joins that sentinel → false. Under a param-type narrowing
    // that makes `x` a positive int, the true branch becomes unreachable
    // and purity should become true.
    const { ast, worklist } = build(`
def hot(x):
    if x <= 0:
        print("no collatz here")
        return -1
    if x == 1:
        return 1
    return hot(x - 1)
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;

    // ROOT: both branches reachable, print block poisons purity.
    expect(worklist.tryRead(purityScopeAnalysis, fn.id, ROOT_CONTEXT)).toBe(false);

    // Speculate: observe a positive-int param. The observation translator
    // extends the unit's speculation context with `x : int` (lifted type).
    worklist.observe(runtimeParamAnalysis, paramKey(fn.id, 0), { kind: "number", value: 8 }, ROOT_CONTEXT);
    worklist.drain();

    const unit = worklist.topology.unitOfFunctionId(fn.id)!;
    const specCtx = worklist.specAssumptionChainFor(unit);
    expect(specCtx).not.toBe(ROOT_CONTEXT);

    // Under the speculative type context, constAnalysis narrows `x <= 0`
    // based on x:pos-int; the branch-true edge is dead; the impure block
    // is unreachable; purity becomes true.
    const specPurity = worklist.tryRead(purityScopeAnalysis, fn.id, specCtx);
    expect(specPurity).toBe(true);
  });
});
