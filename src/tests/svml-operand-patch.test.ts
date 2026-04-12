/**
 * Proves the SVML state-delta seam supports operand-level patching, not just
 * whole-function recompile.
 *
 * The `SVMLSwapStrategy` today emits `{ kind: 'whole' }` unconditionally.
 * Operand-patch emission is a follow-up; this test hand-crafts a
 * `{ kind: 'patches' }` delta and applies it through the same strategy to
 * demonstrate the interface is real, not aspirational.
 *
 * Scenario: compile a function that adds two numeric arguments (`ADDG`
 * dispatched polymorphically), then patch the arithmetic PC to `ADDF`
 * (specialized numeric add). Post-patch execution produces the same numeric
 * result, but via the fast path.
 */

import { StmtNS } from "../ast-types";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import { createReactiveOptimization } from "../specialization";
import { SVMLCompiler } from "../engines/svml/svml-compiler";
import { SVMLInterpreter } from "../engines/svml/svml-interpreter";
import { OpCodes } from "../engines/svml/opcodes";
import type { OperandPatch } from "../engines/svml/types";
import { SVMLSwapStrategy } from "../conductor/svml-swap-strategy";

function buildAdderProgram() {
  const script = `
def add(a, b):
    return a + b
add(2, 3)
`;
  const ast = parse(script) as StmtNS.FileInput;
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const reactive = createReactiveOptimization(ast, environments);
  reactive.converge();
  const compiler = SVMLCompiler.fromProgramUnit(ast, environments, reactive.units);
  const program = compiler.compileProgram(ast);
  const addDef = ast.statements[0] as StmtNS.FunctionDef;
  return { ast, reactive, compiler, program, addDef };
}

function findPc(ir: { opcodes: Int32Array; count: number }, op: number): number {
  for (let pc = 0; pc < ir.count; pc++) {
    if (ir.opcodes[pc] === op) return pc;
  }
  return -1;
}

describe("SVML operand-level patching through SVMLSwapStrategy", () => {
  test("applyDelta with { kind: 'patches' } swaps ADDG → ADDF at the targeted PC", () => {
    const { compiler, program, addDef } = buildAdderProgram();
    const interpreter = new SVMLInterpreter(program);
    const strategy = new SVMLSwapStrategy(compiler, interpreter);

    const index = compiler.indexOf(addDef)!;
    const ir = program.functions[index]!;
    const addgPc = findPc(ir, OpCodes.ADDG);
    expect(addgPc).toBeGreaterThanOrEqual(0);

    // observationSites invariant (documented on applyOperandPatches): the
    // caller guarantees the patched PC is not an observation site, or emits
    // a whole-function delta instead. Binary-arithmetic PCs are never
    // observation sites (those are STORE/CALL only), but assert explicitly
    // so a future change to site emission breaks this test loudly.
    expect(ir.observationSites.has(addgPc)).toBe(false);

    const patch: OperandPatch = { pc: addgPc, opcode: OpCodes.ADDF };
    strategy.applyDelta(addDef, { kind: "patches", patches: [patch] });

    // The in-place patch mutates the SAME typed arrays held by the program.
    expect(ir.opcodes[addgPc]).toBe(OpCodes.ADDF);

    // Post-patch execution runs the specialized fast-path and still yields
    // the correct numeric sum — proves the patched IR is dispatchable.
    const result = interpreter.execute();
    expect(SVMLInterpreter.toJSValue(result)).toBe(5);
  });

  test("operand patch is surgical: mutates the targeted PC in place, leaves neighbors untouched", () => {
    const { compiler, program, addDef } = buildAdderProgram();
    const interpreter = new SVMLInterpreter(program);
    const strategy = new SVMLSwapStrategy(compiler, interpreter);
    const index = compiler.indexOf(addDef)!;

    const ir = program.functions[index]!;
    const addgPc = findPc(ir, OpCodes.ADDG);
    expect(addgPc).toBeGreaterThanOrEqual(0);

    // Snapshot the full opcode stream; only the targeted PC should change.
    const before = Array.from(ir.opcodes.slice(0, ir.count));

    strategy.applyDelta(addDef, {
      kind: "patches",
      patches: [{ pc: addgPc, opcode: OpCodes.ADDF }],
    });

    const after = Array.from(ir.opcodes.slice(0, ir.count));
    for (let pc = 0; pc < before.length; pc++) {
      if (pc === addgPc) {
        expect(after[pc]).toBe(OpCodes.ADDF);
        expect(before[pc]).toBe(OpCodes.ADDG);
      } else {
        expect(after[pc]).toBe(before[pc]);
      }
    }
  });
});
