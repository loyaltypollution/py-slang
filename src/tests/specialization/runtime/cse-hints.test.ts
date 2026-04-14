import { StmtNS } from "../../../ast-types";
import { Context } from "../../../engines/cse/context";
import { generateCSEMachineStateStream } from "../../../engines/cse/interpreter";
import { parse } from "../../../parser/parser-adapter";
import { analyzeWithEnvironments } from "../../../resolver";
import type { FactStore } from "../../../specialization/framework/fact-store";
import { constAnalysisPass } from "../../../specialization/const-analysis/analysis";
import { typeAnalysisPass } from "../../../specialization/type-analysis/analysis";
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
  return { ast, factStore: engine.factStore, context: new Context(ast) };
}

describe("factStore contents after optimization", () => {
  test("integer literal has INT_BIT type and const(42)", () => {
    const { ast, factStore } = optimise("x = 42");
    const rhs = (ast.statements[0] as StmtNS.Assign).value;
    const type = factStore.tryRead(typeAnalysisPass, rhs.id);
    const cv = factStore.tryRead(constAnalysisPass, rhs.id);
    expect(type).toBeDefined();
    expect(type!.kinds & INT_BIT).toBeTruthy();
    expect(cv?.tag).toBe("const");
    expect((cv as { value: unknown }).value).toBe(42);
  });

  test("folded binop 1 + 2 exposes const(3)", () => {
    const { ast, factStore } = optimise("x = 1 + 2");
    const rhs = (ast.statements[0] as StmtNS.Assign).value;
    const cv = factStore.tryRead(constAnalysisPass, rhs.id);
    expect(cv?.tag).toBe("const");
    expect((cv as { value: unknown }).value).toBe(3);
  });

  test("nested function body: return value has a type fact", () => {
    const { ast, factStore } = optimise("def f():\n    return 1 + 2\nf()");
    const ret = (ast.statements[0] as StmtNS.FunctionDef).body[0] as StmtNS.Return;
    expect(factStore.tryRead(typeAnalysisPass, ret.value!.id)).toBeDefined();
  });

  test("root + function scope both contribute to a single merged store", () => {
    const { ast, factStore } = optimise("x = 10\ndef g():\n    return x + 5\ng()");
    const rootRhs = (ast.statements[0] as StmtNS.Assign).value;
    const fnRet = (ast.statements[1] as StmtNS.FunctionDef).body[0] as StmtNS.Return;
    expect(factStore.tryRead(constAnalysisPass, rootRhs.id)?.tag).toBe("const");
    expect(factStore.tryRead(typeAnalysisPass, fnRet.value!.id)).toBeDefined();
  });
});

// Stepper integration: walking the stream should surface at least one node
// whose id matches an entry in the fact store, so visualizer joins land.
describe("stepper ↔ factStore join", () => {
  async function stepAndCollect(
    context: Context,
    factStore: FactStore,
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
        const cv = factStore.tryRead(constAnalysisPass, node.id);
        if (cv !== undefined) hits.push({ id: node.id, cv });
      }
    }
    return hits;
  }

  test("x = 42: stepper passes through a node whose fact is const(42)", async () => {
    const { context, factStore } = optimise("x = 42");
    const hits = await stepAndCollect(context, factStore);
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
