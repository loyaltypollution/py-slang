import { StmtNS } from "../../../ast-types";
import { Context } from "../../../engines/cse/context";
import { generateCSEMachineStateStream } from "../../../engines/cse/interpreter";
import { parse } from "../../../parser/parser-adapter";
import { analyzeWithEnvironments } from "../../../resolver";
import type { Worklist } from "../../../specialization/framework/worklist";
import { constAnalysis, typeAnalysis } from "../../../specialization/framework/dfa-analyses";
import { readExprFact } from "../../../specialization/framework/dfa-factory";
import { INT_BIT } from "../../../specialization/type-analysis/lattice";
import { buildTestWorklist } from "../../utils";

// The CSE stepper does not read facts directly; the visualizer joins the
// worklist's FactStore against stepper state externally by node id. These
// tests pin: (a) facts get populated, (b) the content matches what the
// visualizer will surface, (c) the stepper survives with no fact store.

function optimise(code: string) {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { errors, environments } = analyzeWithEnvironments(ast, script, 4);
  if (errors.length > 0) throw errors[0];
  const engine = buildTestWorklist(ast, environments);
  engine.drain();
  return { ast, engine, context: new Context(ast) };
}

describe("factStore contents after optimization", () => {
  test("integer literal has INT_BIT type and const(42)", () => {
    const { ast, engine } = optimise("x = 42");
    const rhs = (ast.statements[0] as StmtNS.Assign).value;
    const block = engine.blockOfNode(rhs.id);
    const type = readExprFact(engine.factStore, typeAnalysis, block, rhs.id);
    const cv = readExprFact(engine.factStore, constAnalysis, block, rhs.id);
    expect(type).toBeDefined();
    expect(type!.kinds & INT_BIT).toBeTruthy();
    expect(cv?.tag).toBe("const");
    expect((cv as { value: unknown }).value).toBe(42);
  });

  test("folded binop 1 + 2 exposes const(3)", () => {
    const { ast, engine } = optimise("x = 1 + 2");
    const rhs = (ast.statements[0] as StmtNS.Assign).value;
    const cv = readExprFact(
      engine.factStore,
      constAnalysis,
      engine.blockOfNode(rhs.id),
      rhs.id,
    );
    expect(cv?.tag).toBe("const");
    expect((cv as { value: unknown }).value).toBe(3);
  });

  test("nested function body: return value has a type fact", () => {
    const { ast, engine } = optimise("def f():\n    return 1 + 2\nf()");
    const ret = (ast.statements[0] as StmtNS.FunctionDef).body[0] as StmtNS.Return;
    const type = readExprFact(
      engine.factStore,
      typeAnalysis,
      engine.blockOfNode(ret.value!.id),
      ret.value!.id,
    );
    expect(type).toBeDefined();
  });

  test("root + function scope both contribute to a single merged store", () => {
    const { ast, engine } = optimise("x = 10\ndef g():\n    return x + 5\ng()");
    const rootRhs = (ast.statements[0] as StmtNS.Assign).value;
    const fnRet = (ast.statements[1] as StmtNS.FunctionDef).body[0] as StmtNS.Return;
    const rootCv = readExprFact(
      engine.factStore,
      constAnalysis,
      engine.blockOfNode(rootRhs.id),
      rootRhs.id,
    );
    const retType = readExprFact(
      engine.factStore,
      typeAnalysis,
      engine.blockOfNode(fnRet.value!.id),
      fnRet.value!.id,
    );
    expect(rootCv?.tag).toBe("const");
    expect(retType).toBeDefined();
  });
});

// Stepper integration: walking the stream should surface at least one node
// whose id matches an entry in the fact store, so visualizer joins land.
describe("stepper ↔ factStore join", () => {
  async function stepAndCollect(
    context: Context,
    engine: Worklist,
  ): Promise<Array<{ id: number; cv: unknown }>> {
    const gen = generateCSEMachineStateStream(
      "",
      context,
      context.control,
      context.stash,
      -1,
      1000,
      4,
      false,
    );
    const hits: Array<{ id: number; cv: unknown }> = [];
    for await (const _ of gen) {
      const node = context.runtime.nodes[0];
      if (node && "id" in node && typeof node.id === "number") {
        const cv = readExprFact(
          engine.factStore,
          constAnalysis,
          engine.blockOfNode(node.id),
          node.id,
        );
        if (cv !== undefined) hits.push({ id: node.id, cv });
      }
    }
    return hits;
  }

  test("x = 42: stepper analyses through a node whose fact is const(42)", async () => {
    const { context, engine } = optimise("x = 42");
    const hits = await stepAndCollect(context, engine);
    expect(hits.length).toBeGreaterThan(0);
    const has42 = hits.some(
      h => (h.cv as { tag: string; value?: unknown })?.tag === "const" &&
        (h.cv as { value: unknown }).value === 42,
    );
    expect(has42).toBe(true);
  });
});

describe("stepper without fact store", () => {
  test("runs to completion without throwing", async () => {
    const script = "x = 1\n";
    const ast = parse(script) as StmtNS.FileInput;
    analyzeWithEnvironments(ast, script, 4);
    const context = new Context(ast);
    const gen = generateCSEMachineStateStream(
      "",
      context,
      context.control,
      context.stash,
      -1,
      1000,
      4,
      false,
    );
    let count = 0;
    for await (const _ of gen) count++;
    expect(count).toBeGreaterThan(0);
  });
});
