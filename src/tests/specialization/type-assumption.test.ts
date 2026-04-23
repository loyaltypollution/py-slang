import { ExprNS, StmtNS } from "../../ast-types";
import { ROOT_CONTEXT } from "../../specialization/lattice/chain";
import { extend } from "../../specialization/lattice/algebra";
import { typeAnalysis } from "../../specialization/framework/narrowing-registry";
import { typeNarrowing } from "../../specialization/type-analysis/analysis";
import { INT_BIT, INT_POS, TOP } from "../../specialization/type-analysis/lattice";
import { setupAndDrain } from "./harness/compile-pipelines";

describe("typeAnalysis under a non-ROOT context", () => {
  test("assumption at nodeId narrows the per-node fact via meet", () => {
    const { ast, worklist } = setupAndDrain(`
def hot(x):
    y = x
    return y * 2
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const xRead = (fn.body[0] as StmtNS.Assign).value as ExprNS.Variable;
    const block = worklist.topology.blockOfNode(xRead.id)!;

    // ROOT-context fact: x is a parameter slot → TOP.
    expect(typeAnalysis.perExpr(worklist.topology).tryRead(xRead.id, ROOT_CONTEXT)?.kinds)
      .not.toBe(INT_BIT);

    // Build a Context with a single assumption: x at `xRead.id` is INT_POS.
    const ctx = extend(ROOT_CONTEXT, typeNarrowing, xRead.id, INT_POS);

    // Re-run typeAnalysis under the context.
    worklist.enqueue(typeAnalysis.env, block.unit.cfg.entry, ctx);
    worklist.drain();

    // The non-ROOT cell holds the narrowed fact.
    const narrowed = worklist.tryRead(typeAnalysis.facts, block, ctx)?.get(xRead.id);
    expect(narrowed?.kinds).toBe(INT_BIT);

    // The ROOT cell is unaffected — independent Kildall per context.
    const rootStill = typeAnalysis.perExpr(worklist.topology).tryRead(xRead.id, ROOT_CONTEXT);
    expect(rootStill?.kinds).not.toBe(INT_BIT);
  });

  test("a node without an assumption in the context is not narrowed", () => {
    // Both w and y are returned (via tuple), so dead-store elimination can't
    // prune `w = z`. Positional traversal would still be brittle against
    // transform-driven reordering; find reads by name.
    const { ast, worklist } = setupAndDrain(`
def hot(x, z):
    y = x
    w = z
    return y + w
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const xAssign = fn.body.find(
      s => s instanceof StmtNS.Assign
        && s.value instanceof ExprNS.Variable
        && s.value.name.lexeme === "x",
    ) as StmtNS.Assign;
    const zAssign = fn.body.find(
      s => s instanceof StmtNS.Assign
        && s.value instanceof ExprNS.Variable
        && s.value.name.lexeme === "z",
    ) as StmtNS.Assign;
    const xRead = xAssign.value as ExprNS.Variable;
    const zRead = zAssign.value as ExprNS.Variable;
    const block = worklist.topology.blockOfNode(xRead.id)!;

    // Assumption only at xRead.id, not zRead.id.
    const ctx = extend(ROOT_CONTEXT, typeNarrowing, xRead.id, INT_POS);
    worklist.enqueue(typeAnalysis.env, block.unit.cfg.entry, ctx);
    worklist.drain();

    const xFact = worklist.tryRead(typeAnalysis.facts, block, ctx)?.get(xRead.id);
    const zFact = worklist.tryRead(typeAnalysis.facts, block, ctx)?.get(zRead.id);

    expect(xFact?.kinds).toBe(INT_BIT);
    // z passes static through (TOP for a parameter) — unchanged by the
    // x-only assumption.
    expect(zFact).toEqual(TOP);
  });

  test("siblings: two contexts with different assumptions yield independent narrowings", () => {
    const { ast, worklist } = setupAndDrain(`
def hot(x):
    y = x
    return y * 2
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const xRead = (fn.body[0] as StmtNS.Assign).value as ExprNS.Variable;
    const block = worklist.topology.blockOfNode(xRead.id)!;

    const ctxIntPos = extend(ROOT_CONTEXT, typeNarrowing, xRead.id, INT_POS);
    // A different assumption value at the same node.
    const ctxNeg = extend(ROOT_CONTEXT, typeNarrowing, xRead.id, {
      ...INT_POS,
      intRef: 1, // IntRef.Neg
    });

    worklist.enqueue(typeAnalysis.env, block.unit.cfg.entry, ctxIntPos);
    worklist.enqueue(typeAnalysis.env, block.unit.cfg.entry, ctxNeg);
    worklist.drain();

    const posFact = worklist.tryRead(typeAnalysis.facts, block, ctxIntPos)?.get(xRead.id);
    const negFact = worklist.tryRead(typeAnalysis.facts, block, ctxNeg)?.get(xRead.id);

    expect(posFact).not.toEqual(negFact);
    expect(posFact?.intRef).toBe(INT_POS.intRef);
  });
});
