/**
 * Phase 4 regression: SVML function indices must be stable across recompiles,
 * and `SVMLCompiler.compileFunction(unit)` must produce an IR whose index
 * matches what `compileProgram` would have assigned — otherwise patching a
 * single function would invalidate every `NEWC <index>` operand in its
 * sibling functions.
 */
import { ExprNS, StmtNS } from "../ast-types";
import { SVMLCompiler } from "../engines/svml/svml-compiler";
import { constAnalysis, typeAnalysis } from "../specialization/analysis";
import { ROOT_CONTEXT } from "../specialization/assumption/chain";
import OpCodes from "../engines/svml/opcodes";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import math from "../stdlib/math";
import memo from "../stdlib/memo";
import misc from "../stdlib/misc";
import { traverseAST } from "../validator/traverse";
import { buildTestWorklist } from "./utils";
import type { FunctionManager } from "../specialization/program/units/function/manager";

function build(code: string) {
  const script = code + "\n";
  const ast = parse(script);
  const { errors, environments } = analyzeWithEnvironments(ast, script, 4, [misc, math, memo]);
  if (errors.length > 0) throw errors[0];
  const engine = buildTestWorklist(ast, environments);
  engine.drain();
  // For Function-flavored tests we need both the UnitDomain `values()`
  // surface and the FunctionLocator `functionById` surface — Worklist's
  // public `units: UnitDomain<Function, FunctionLocator>` typing only
  // exposes the former. The default constructor uses FunctionManager so
  // the cast is sound.
  const functions = engine.units as FunctionManager;
  const typeStore = typeAnalysis.perExpr(engine.locate);
  const constStore = constAnalysis.perExpr(engine.locate);
  const compiler = SVMLCompiler.fromProgramUnit(ast, environments, {
    typeOf: id => typeStore.tryRead(id, ROOT_CONTEXT),
    constOf: id => constStore.tryRead(id, ROOT_CONTEXT),
  });
  return { ast, environments, functions, compiler };
}

describe("SVML stable function indices", () => {
  const program = `
def f(x):
    return x + 1
def g(y):
    def h(z):
        return z + y
    return h(y)
f(1)
g(2)
`;

  test("compileProgram produces the same StmtNS.FileInput | StmtNS.FunctionDef → index map across recompiles", () => {
    const a = build(program);
    const programA = a.compiler.compileProgram(a.ast);
    const mapA: Array<[string, number]> = [];
    for (const unit of a.functions.values()) {
      const scope = unit.funcAst;
      const idx = a.compiler.indexOf(scope)!;
      const name = scope instanceof StmtNS.FunctionDef ? scope.name.lexeme : "<file>";
      mapA.push([name, idx]);
    }

    const b = build(program);
    const programB = b.compiler.compileProgram(b.ast);
    const mapB: Array<[string, number]> = [];
    for (const unit of b.functions.values()) {
      const scope = unit.funcAst;
      const idx = b.compiler.indexOf(scope)!;
      const name = scope instanceof StmtNS.FunctionDef ? scope.name.lexeme : "<file>";
      mapB.push([name, idx]);
    }

    expect(mapA).toEqual(mapB);
    expect(programA.functions.length).toBe(programB.functions.length);
  });

  test("compileFunction returns an IR whose bytecode matches compileProgram's slot for the same unit", () => {
    const { ast, functions, compiler } = build(program);
    const fullProgram = compiler.compileProgram(ast);

    // Pick the `h` unit (nested inside `g`)
    let hUnit: ReturnType<typeof functions.functionById> | undefined;
    for (const unit of functions.values()) {
      const scope = unit.funcAst;
      if (scope instanceof StmtNS.FunctionDef && scope.name.lexeme === "h") {
        hUnit = unit;
        break;
      }
    }
    expect(hUnit).toBeDefined();

    const hIndex = compiler.indexOf(hUnit!.funcAst)!;
    const fullIr = fullProgram.functions[hIndex];

    const recompiled = compiler.compileFunction(hUnit!);
    expect(recompiled.count).toBe(fullIr.count);
    expect(Array.from(recompiled.opcodes)).toEqual(Array.from(fullIr.opcodes));
    expect(Array.from(recompiled.arg1s)).toEqual(Array.from(fullIr.arg1s));
    expect(Array.from(recompiled.arg2s)).toEqual(Array.from(fullIr.arg2s));
    expect(recompiled.numArgs).toBe(fullIr.numArgs);
    expect(recompiled.envSize).toBe(fullIr.envSize);
  });

  test("NEWC operands in sibling functions reference the index compileFunction assigns", () => {
    const { ast, functions, compiler } = build(program);
    const fullProgram = compiler.compileProgram(ast);

    // g emits NEWC <h-index> when defining inner h. Verify that operand matches
    // the index compileFunction would build for h's unit.
    let gIndex = -1;
    let hIndex = -1;
    for (const unit of functions.values()) {
      const scope = unit.funcAst;
      if (scope instanceof StmtNS.FunctionDef) {
        if (scope.name.lexeme === "g") gIndex = compiler.indexOf(scope)!;
        if (scope.name.lexeme === "h") hIndex = compiler.indexOf(scope)!;
      }
    }
    expect(gIndex).toBeGreaterThanOrEqual(0);
    expect(hIndex).toBeGreaterThanOrEqual(0);

    const gIr = fullProgram.functions[gIndex];
    let foundNewc = false;
    for (let i = 0; i < gIr.count; i++) {
      if (gIr.opcodes[i] === OpCodes.NEWC) {
        expect(gIr.arg1s[i]).toBe(hIndex);
        foundNewc = true;
      }
    }
    expect(foundNewc).toBe(true);
  });

  describe("lambda/multilambda slot stability", () => {
    // Program interleaves FunctionDef, Lambda, MultiLambda so that an
    // incorrect walk (e.g. FunctionDef-only) would assign different slot
    // indices than a correct pre-order DFS over all function-scope nodes.
    const lambdaProgram = `
def f(x):
    return x + 1
sq = lambda y: y * y
def g(z):
    twice = lambda w: w + w
    return sq(z) + twice(z) + f(z)
g(3)
`;

    function collectFunctionScopeNodes(ast: StmtNS.FileInput) {
      const nodes: Array<StmtNS.FileInput | StmtNS.FunctionDef | ExprNS.Lambda | ExprNS.MultiLambda> = [ast];
      traverseAST(ast, node => {
        if (
          node instanceof StmtNS.FunctionDef ||
          node instanceof ExprNS.Lambda ||
          node instanceof ExprNS.MultiLambda
        ) {
          nodes.push(node);
        }
      });
      return nodes;
    }

    test("SVMLProgram.functions has one slot per function-scope node (FileInput + FunctionDef + Lambda + MultiLambda)", () => {
      const { ast, compiler } = build(lambdaProgram);
      const program = compiler.compileProgram(ast);
      const expected = collectFunctionScopeNodes(ast).length;
      expect(program.functions.length).toBe(expected);
    });

    test("per-function bytecode is identical across independent builds of a lambda-containing program", () => {
      // This pins NEWC operands for lambdas: if the walk order changes,
      // lambda slots shift and the NEWC operand in g would diverge.
      const a = build(lambdaProgram);
      const progA = a.compiler.compileProgram(a.ast);
      const b = build(lambdaProgram);
      const progB = b.compiler.compileProgram(b.ast);

      expect(progA.functions.length).toBe(progB.functions.length);
      for (let i = 0; i < progA.functions.length; i++) {
        const fa = progA.functions[i];
        const fb = progB.functions[i];
        expect(Array.from(fb.opcodes)).toEqual(Array.from(fa.opcodes));
        expect(Array.from(fb.arg1s)).toEqual(Array.from(fa.arg1s));
        expect(Array.from(fb.arg2s)).toEqual(Array.from(fa.arg2s));
      }
    });

    test("NEWC operands for lambdas point at slots that are actually populated", () => {
      const { ast, compiler } = build(lambdaProgram);
      const program = compiler.compileProgram(ast);
      for (const ir of program.functions) {
        for (let i = 0; i < ir.count; i++) {
          if (ir.opcodes[i] === OpCodes.NEWC) {
            const slot = ir.arg1s[i];
            expect(slot).toBeGreaterThanOrEqual(0);
            expect(slot).toBeLessThan(program.functions.length);
          }
        }
      }
    });
  });

  test("compileFunction produces stable output across repeated calls", () => {
    // Two independently built compilers (same source) plus a compileFunction
    // on one of them should produce the same IR byte-for-byte as the full
    // compile on the other. This is the invariant that lets an OSR installer
    // splice a fresh per-function IR into an existing SVMLProgram.
    const a = build(program);
    const progA = a.compiler.compileProgram(a.ast);

    const b = build(program);
    let hUnitB: ReturnType<typeof b.functions.functionById> | undefined;
    for (const unit of b.functions.values()) {
      const scope = unit.funcAst;
      if (scope instanceof StmtNS.FunctionDef && scope.name.lexeme === "h") hUnitB = unit;
    }
    const hIndex = b.compiler.indexOf(hUnitB!.funcAst)!;
    const ir1 = b.compiler.compileFunction(hUnitB!);
    const ir2 = b.compiler.compileFunction(hUnitB!);

    expect(Array.from(ir1.opcodes)).toEqual(Array.from(ir2.opcodes));
    expect(Array.from(ir1.arg1s)).toEqual(Array.from(ir2.arg1s));
    expect(Array.from(ir1.opcodes)).toEqual(Array.from(progA.functions[hIndex].opcodes));
    expect(Array.from(ir1.arg1s)).toEqual(Array.from(progA.functions[hIndex].arg1s));
  });
});
