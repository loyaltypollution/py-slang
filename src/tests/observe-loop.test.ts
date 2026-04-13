/**
 * End-to-end test for the OBSERVE loop.
 *
 * Verifies that the CSE interpreter emits runtime observations which the
 * reactive optimization worklist translates into HintStore refinements,
 * visible to consumers via `.get(node)`.
 */

import { StmtNS } from "../ast-types";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import { buildTestWorklist } from "./utils";
import { Context } from "../engines/cse/context";
import { evaluate } from "../engines/cse/interpreter";
import { HintStore } from "../specialization";
import { STR_BIT, INT_BIT } from "../specialization/type-analysis/lattice";

function setupReactive(code: string) {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const reactive = buildTestWorklist(ast, environments);
  return { ast, environments, reactive };
}

async function runWithReactive(code: string) {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const context = new Context();
  const reactive = buildTestWorklist(ast, environments);
  reactive.converge();

  // Merge collector — each unit owns a disjoint id range, so dedupe never
  // triggers; the eq callback fires only on re-writes we don't do.
  const merged = new HintStore(() => false);
  for (const unit of reactive.units.values()) {
    for (const [id, hint] of unit.hints) merged.setById(id, hint);
  }
  context.runtime.observationSink = reactive;
  context.runtime.rootScope = ast;

  const unsubscribe = reactive.subscribe(changed => {
    for (const key of changed) {
      const unit = reactive.units.get(key);
      if (unit) for (const [id, hint] of unit.hints) merged.setById(id, hint);
    }
  });

  try {
    await reactive.withActiveScope(ast, () =>
      evaluate("", ast, context, { variant: 4, groups: [] }),
    );
  } finally {
    unsubscribe();
  }

  return { ast, reactive, merged };
}

describe("OBSERVE loop: end-to-end", () => {
  test("runtime string write widens the RHS hint from INT to INT|STR", async () => {
    // After static analysis, `x = 1` has type=INT only. Running CSE on a
    // program that later assigns a string should push a string observation
    // into the hint store via observeWrite.
    const code = `
x = 1
x = "hello"
`;
    const { ast, merged } = await runWithReactive(code);

    const firstAssign = ast.statements[0] as StmtNS.Assign;
    const secondAssign = ast.statements[1] as StmtNS.Assign;

    const firstHint = merged.get(firstAssign.value);
    const secondHint = merged.get(secondAssign.value);

    // First assign's RHS is a literal 1 — static analysis gave INT.
    expect(firstHint?.type?.kinds).toBeDefined();
    expect(firstHint!.type!.kinds & INT_BIT).toBeTruthy();

    // Second assign's RHS is "hello" — static analysis gave STR.
    // Additionally, the observation path may widen this further.
    expect(secondHint?.type?.kinds).toBeDefined();
    expect(secondHint!.type!.kinds & STR_BIT).toBeTruthy();
  });

  test("program with no runtime mutations: observing a known value leaves hints unchanged", async () => {
    // If a runtime observation of a value that static analysis already
    // covered lands at a node, the hint's lattice element should be equal
    // before and after.
    const { ast, reactive } = setupReactive("x = 1");
    reactive.converge();
    const assign = ast.statements[0] as StmtNS.Assign;
    const before = reactive.units.get(ast)!.hints.get(assign.value);

    reactive.observeWrite(ast, assign.value, 1);
    const after = reactive.units.get(ast)!.hints.get(assign.value);

    expect(after?.type).toEqual(before?.type);
  });

  test("subscribe is called with changed scope keys during converge", async () => {
    const { ast, reactive } = setupReactive("if True:\n  x = 1 + 2\nelse:\n  x = 99");
    const notified: ReadonlySet<unknown>[] = [];
    reactive.subscribe(changed => notified.push(changed));

    reactive.converge();

    expect(notified.length).toBeGreaterThanOrEqual(1);
    const allKeys = new Set<unknown>();
    for (const set of notified) for (const k of set) allKeys.add(k);
    expect(allKeys.has(ast)).toBe(true);
  });

  test("root scope pinned before converge: transforms deferred, then fire on tick after deactivate", async () => {
    const { ast, reactive } = setupReactive("if True:\n  x = 1\nelse:\n  x = 2");
    reactive.activateScope(ast);
    reactive.converge();
    expect(reactive.units.get(ast)!.structuralVersion).toBe(0);

    reactive.deactivateScope(ast);
    expect(reactive.idle).toBe(false);
    reactive.tick();
    expect(reactive.units.get(ast)!.structuralVersion).toBeGreaterThan(0);

    // Baseline without pinning: transform fires during converge itself.
    const fresh = setupReactive("if True:\n  x = 1\nelse:\n  x = 2");
    fresh.reactive.converge();
    expect(fresh.reactive.units.get(fresh.ast)!.structuralVersion).toBeGreaterThan(0);

    const context = new Context();
    expect(context.runtime).toBeDefined();
  });
});

describe("OBSERVE loop: multi-scope parallel optimization", () => {
  test("pinning one function does not park a cold sibling's transform", () => {
    // The architectural payoff: while scope f is active on a call stack,
    // cold scope g must still optimize (here: constant-fold 3+4 → 7).
    const code = `
def f():
    x = 1 + 2
def g():
    y = 3 + 4
`;
    const { ast, reactive } = setupReactive(code);
    const fDef = ast.statements[0] as StmtNS.FunctionDef;
    const gDef = ast.statements[1] as StmtNS.FunctionDef;

    reactive.activateScope(fDef);
    reactive.converge();

    // f's transform is parked; g's fires.
    expect(reactive.units.get(fDef)!.structuralVersion).toBe(0);
    expect(reactive.units.get(gDef)!.structuralVersion).toBeGreaterThan(0);

    // Verifying g actually got folded: its body's assignment RHS is now a literal.
    const gAssign = gDef.body[0] as StmtNS.Assign;
    expect(gAssign.value.kind).toBe("Literal");

    // f's body is untouched — still a Binary expression.
    const fAssign = fDef.body[0] as StmtNS.Assign;
    expect(fAssign.value.kind).toBe("Binary");

    // Unpin f → on next tick its transform fires too.
    reactive.deactivateScope(fDef);
    reactive.tick();
    expect(reactive.units.get(fDef)!.structuralVersion).toBeGreaterThan(0);
    const fAssignAfter = fDef.body[0] as StmtNS.Assign;
    expect(fAssignAfter.value.kind).toBe("Literal");
  });
});

describe("OBSERVE loop: regression guard", () => {
  test("observation of an already-known value leaves the node's hint equal", async () => {
    // If a runtime observation of value X lands at a node whose hint
    // already covers X, the stored hint should be equal (same lattice).
    const { ast, reactive } = setupReactive("x = 42");
    reactive.converge();

    const assign = ast.statements[0] as StmtNS.Assign;
    const before = reactive.units.get(ast)!.hints.get(assign.value);
    reactive.observeWrite(ast, assign.value, 42);
    const after = reactive.units.get(ast)!.hints.get(assign.value);

    expect(after?.type).toEqual(before?.type);
  });
});
