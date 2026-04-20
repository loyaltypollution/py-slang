// Entry-guard projection tests.
//
// Contracts verified:
//   1. FileInput unit returns undefined (no parameters).
//   2. Zero-param FunctionDef returns undefined.
//   3. ROOT_CONTEXT returns undefined (no narrowing assumptions).
//   4. Non-param-related narrowings produce no guards.

import { StmtNS } from "../../../ast-types";
import { parse } from "../../../parser/parser-adapter";
import { analyzeWithEnvironments } from "../../../resolver";
import { ROOT_CONTEXT } from "../../../specialization/framework/context";
import { paramKey } from "../../../specialization/framework/key-spaces";
import { runtimeParamAnalysis } from "../../../specialization/framework/runtime-analyses";
import {
  entryGuardsFor,
  guardKeyFor,
  paramTypeNarrowing,
} from "../../../specialization/entry-guards";
import { buildTestWorklist } from "../../utils";

function buildWorklist(code: string) {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const worklist = buildTestWorklist(ast, environments);
  worklist.drain();
  return { ast, worklist };
}

describe("entryGuardsFor: units without parameters", () => {
  test("FileInput unit returns undefined", () => {
    const { ast, worklist } = buildWorklist("x = 1");
    const unit = worklist.topology.unitOfFunctionId(ast.id)!;
    expect(entryGuardsFor(unit, ROOT_CONTEXT)).toBeUndefined();
  });

  test("zero-parameter function returns undefined", () => {
    const { ast, worklist } = buildWorklist("def f():\n    return 1");
    const fd = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.topology.unitOfFunctionId(fd.id)!;
    expect(entryGuardsFor(unit, ROOT_CONTEXT)).toBeUndefined();
  });
});

describe("entryGuardsFor: ROOT_CONTEXT always returns undefined", () => {
  test("single-param function, ROOT context → undefined", () => {
    const { ast, worklist } = buildWorklist("def f(x):\n    return x");
    const fd = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.topology.unitOfFunctionId(fd.id)!;
    expect(entryGuardsFor(unit, ROOT_CONTEXT)).toBeUndefined();
  });

  test("multi-param function, ROOT context → undefined", () => {
    const { ast, worklist } = buildWorklist("def f(x, y):\n    return x + y");
    const fd = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.topology.unitOfFunctionId(fd.id)!;
    expect(entryGuardsFor(unit, ROOT_CONTEXT)).toBeUndefined();
  });
});

describe("entryGuardsFor: direct parameter assumptions", () => {
  test("runtime parameter observation projects to a param-type guard", () => {
    const { ast, worklist } = buildWorklist("def f(x):\n    if x:\n        return 1\n    return 0");
    const fd = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.topology.unitOfFunctionId(fd.id)!;
    worklist.observe(runtimeParamAnalysis, paramKey(fd.id, 0), { kind: "bool", value: true });
    worklist.drain();
    expect(entryGuardsFor(unit, worklist.specAssumptionChainFor(unit))).toContainEqual({
      kind: "param-type",
      paramIndex: 0,
      ty: require("../../../specialization/type-analysis/lattice").BOOL_TRUE,
    });
  });

  test("direct param assumptions replace same-key older values via Context semantics", () => {
    const { ast, worklist } = buildWorklist("def f(x):\n    return x");
    const fd = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.topology.unitOfFunctionId(fd.id)!;
    const { extendContext } = require("../../../specialization/framework/context");
    const { BOOL_FALSE, BOOL_TRUE } = require("../../../specialization/type-analysis/lattice");
    const first = extendContext(ROOT_CONTEXT, paramTypeNarrowing, paramKey(fd.id, 0), BOOL_FALSE);
    const second = extendContext(first, paramTypeNarrowing, paramKey(fd.id, 0), BOOL_TRUE);
    expect(entryGuardsFor(unit, second)).toEqual([{ kind: "param-type", paramIndex: 0, ty: BOOL_TRUE }]);
  });
});

describe("guardKeyFor", () => {
  test("returns undefined when no entry guards exist", () => {
    const { ast, worklist } = buildWorklist("def f(x):\n    return x");
    const fd = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.topology.unitOfFunctionId(fd.id)!;
    expect(guardKeyFor(unit, ROOT_CONTEXT)).toBeUndefined();
  });

  test("canonicalizes same visible guards across context construction order", () => {
    const { extendContext } = require("../../../specialization/framework/context");
    const { BOOL_TRUE, INT_POS } = require("../../../specialization/type-analysis/lattice");

    const { ast, worklist } = buildWorklist("def f(x, y):\n    return x");
    const fd = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.topology.unitOfFunctionId(fd.id)!;

    const xy = extendContext(
      extendContext(ROOT_CONTEXT, paramTypeNarrowing, paramKey(fd.id, 0), INT_POS),
      paramTypeNarrowing,
      paramKey(fd.id, 1),
      BOOL_TRUE,
    );
    const yx = extendContext(
      extendContext(ROOT_CONTEXT, paramTypeNarrowing, paramKey(fd.id, 1), BOOL_TRUE),
      paramTypeNarrowing,
      paramKey(fd.id, 0),
      INT_POS,
    );

    expect(guardKeyFor(unit, xy)).toBe(guardKeyFor(unit, yx));
  });
});

describe("entryGuardsFor: non-entry-guardable narrowings produce no guards", () => {
  test("constNarrowing assumption on interior expression → no entry guards", () => {
    // constNarrowing keyed by a nodeId that is NOT a param read cannot be
    // projected to an entry guard in v1. entryGuardsFor only uses
    // requirementAtEntry (returnKindNarrowing path), so an unrelated const
    // assumption on an interior expression must not leak through.
    const { extendContext } = require("../../../specialization/framework/context");
    const { typeNarrowing } = require("../../../specialization/type-analysis/analysis");
    const { INT_POS } = require("../../../specialization/type-analysis/lattice");

    const code = `
def f(x):
    y = x + 1
    return y
`;
    const { ast, worklist } = buildWorklist(code);
    const fd = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.topology.unitOfFunctionId(fd.id)!;
    // y's assignment value (x + 1) — pick any interior nodeId
    const assign = fd.body[0] as StmtNS.Assign;
    const rhsId = assign.value.id;
    const ctx = extendContext(ROOT_CONTEXT, typeNarrowing, rhsId, INT_POS);
    // No returnKindNarrowing → requirementAtEntry returns empty provable → undefined
    expect(entryGuardsFor(unit, ctx)).toBeUndefined();
  });
});
