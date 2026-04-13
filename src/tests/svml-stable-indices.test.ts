/**
 * Phase 4 regression: SVML function indices must be stable across recompiles,
 * and `SVMLCompiler.compileFunction(unit)` must produce an IR whose index
 * matches what `compileProgram` would have assigned — otherwise patching a
 * single function would invalidate every `NEWC <index>` operand in its
 * sibling functions.
 */
import { StmtNS } from "../ast-types";
import { SVMLCompiler } from "../engines/svml/svml-compiler";
import OpCodes from "../engines/svml/opcodes";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import { buildTestWorklist } from "./utils";

function build(code: string) {
  const script = code + "\n";
  const ast = parse(script);
  const { errors, environments } = analyzeWithEnvironments(ast, script, 4);
  if (errors.length > 0) throw errors[0];
  const engine = buildTestWorklist(ast, environments);
  engine.converge();
  const units = engine.units;
  const compiler = SVMLCompiler.fromProgramUnit(ast, environments, units, engine.factStore);
  return { ast, environments, units, compiler };
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

  test("scopeIndexMap is populated before compileProgram runs", () => {
    const { compiler } = build(program);
    const map = compiler.scopeIndexMap!;
    expect(map).toBeDefined();
    // FileInput + f + g + h
    expect(map.size).toBe(4);
  });

  test("compileProgram produces the same StmtNS.FileInput | StmtNS.FunctionDef → index map across recompiles", () => {
    const a = build(program);
    const programA = a.compiler.compileProgram(a.ast);
    const mapA: Array<[string, number]> = [];
    for (const [scope, unit] of a.units) {
      void unit;
      const idx = a.compiler.indexOf(scope)!;
      const name = scope instanceof StmtNS.FunctionDef ? scope.name.lexeme : "<file>";
      mapA.push([name, idx]);
    }

    const b = build(program);
    const programB = b.compiler.compileProgram(b.ast);
    const mapB: Array<[string, number]> = [];
    for (const [scope, unit] of b.units) {
      void unit;
      const idx = b.compiler.indexOf(scope)!;
      const name = scope instanceof StmtNS.FunctionDef ? scope.name.lexeme : "<file>";
      mapB.push([name, idx]);
    }

    expect(mapA).toEqual(mapB);
    expect(programA.functions.length).toBe(programB.functions.length);
  });

  test("compileFunction returns an IR whose bytecode matches compileProgram's slot for the same unit", () => {
    const { ast, units, compiler } = build(program);
    const fullProgram = compiler.compileProgram(ast);

    // Pick the `h` unit (nested inside `g`)
    let hUnit: ReturnType<typeof units.get> | undefined;
    for (const [scope, unit] of units) {
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
    const { ast, units, compiler } = build(program);
    const fullProgram = compiler.compileProgram(ast);

    // g emits NEWC <h-index> when defining inner h. Verify that operand matches
    // the index compileFunction would build for h's unit.
    let gIndex = -1;
    let hIndex = -1;
    for (const [scope] of units) {
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

  test("compileFunction produces stable output across repeated calls", () => {
    // Two independently built compilers (same source) plus a compileFunction
    // on one of them should produce the same IR byte-for-byte as the full
    // compile on the other. This is the invariant that lets an OSR installer
    // splice a fresh per-function IR into an existing SVMLProgram.
    const a = build(program);
    const progA = a.compiler.compileProgram(a.ast);

    const b = build(program);
    let hUnitB: ReturnType<typeof b.units.get> | undefined;
    for (const [scope, unit] of b.units) {
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
