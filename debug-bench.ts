// Honest measurement: does speculative ADDF/MULF specialization actually
// speed up the interpreter on a tight numeric loop?
//
// Test design: function with statically-TOP parameter, dispatch-heavy inner
// loop with many binary ops. Two compiles:
//   - baseline: no observation → ADDG/MULG (generic, runtime typeof check)
//   - speculative: observation pins param → ADDF/MULF + GUARD_KIND on reads
//
// If speculation beats baseline measurably on the SAME interpreter, the
// premise "JIT beats interpreter" holds. If not, GUARD_KIND is also fiction.

import { ExprNS, StmtNS } from "./src/ast-types";
import { parse } from "./src/parser/parser-adapter";
import { analyzeWithEnvironments } from "./src/resolver";
import { runtimeWriteAnalysis } from "./src/specialization/framework/runtime-analyses";
import { SVMLCompiler } from "./src/engines/svml/svml-compiler";
import { SVMLInterpreter } from "./src/engines/svml/svml-interpreter";
import OpCodes from "./src/engines/svml/opcodes";
import { Worklist } from "./src/specialization/framework/worklist";
import { makeDfaQuery } from "./src/specialization";

const code = `
def kernel(x, n):
    m = x
    s = 0
    i = 0
    while i < n:
        s = s + m + m + m + i + i + i + m + i + m + i
        i = i + 1
    return s

print(kernel(1, ${process.argv[2] ?? "200000"}))
` + "\n";

function compile(observe: boolean) {
  const ast = parse(code) as StmtNS.FileInput;
  const { environments } = analyzeWithEnvironments(ast, code, 4);
  const wl = new Worklist(ast, environments);
  wl.drain();
  if (observe) {
    const kernel = ast.statements.find(s => s instanceof StmtNS.FunctionDef && (s as any).name?.lexeme === "kernel") as StmtNS.FunctionDef;
    const mAssign = kernel.body[0] as StmtNS.Assign;
    const xRead = mAssign.value as ExprNS.Variable;
    wl.observe(runtimeWriteAnalysis, xRead.id, { kind: "number", value: 1 });
    wl.drain();
  }
  const compiler = SVMLCompiler.fromProgramUnit(ast, environments, makeDfaQuery(wl.factStore, wl.nodeIndex), wl.registry);
  return compiler.compileProgram(ast);
}

function countOpcodes(p: ReturnType<typeof compile>) {
  const counts = new Map<string, number>();
  for (const fn of p.functions) {
    for (let i = 0; i < fn.count; i++) {
      const name = OpCodes[fn.opcodes[i]] ?? "?";
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return counts;
}

function run(p: ReturnType<typeof compile>): { ms: number; result: unknown } {
  const interp = new SVMLInterpreter(p, { sendOutput: () => {}, maxInstructions: 1e9 });
  const t0 = performance.now();
  const result = interp.execute();
  const t1 = performance.now();
  return { ms: t1 - t0, result };
}

// Diagnose: why isn't ADDF firing?
import { speculativeTypeAnalysis, typeAnalysis } from "./src/specialization/framework/dfa-analyses";
import { purityScopeAnalysis } from "./src/specialization/purity-analysis/analysis";
import { readExprFact } from "./src/specialization/framework/dfa-factory";

{
  const ast = parse(code) as StmtNS.FileInput;
  const { environments } = analyzeWithEnvironments(ast, code, 4);
  const wl = new Worklist(ast, environments);
  wl.drain();
  const kernel = ast.statements.find(s => s instanceof StmtNS.FunctionDef && (s as any).name?.lexeme === "kernel") as StmtNS.FunctionDef;
  const mAssign = kernel.body[0] as StmtNS.Assign;
  const xRead = mAssign.value as ExprNS.Variable;
  wl.observe(runtimeWriteAnalysis, xRead.id, { kind: "number", value: 1 });
  wl.drain();

  console.log("kernel.id:", kernel.id, "purity:", wl.factStore.tryRead(purityScopeAnalysis, kernel.id));

  // Find an `m` read inside the while loop body.
  const whileStmt = kernel.body.find(s => s instanceof StmtNS.While) as StmtNS.While;
  console.log("while condition:", whileStmt.condition.constructor.name);
  // s = s + m + m + m + ...
  const sAssign = whileStmt.body[0] as StmtNS.Assign;
  const rhs = sAssign.value as ExprNS.Binary;
  console.log("rhs root op:", (rhs as any).operator?.lexeme);
  // Check if `m` is resolved as local to kernel.
  const kenv = environments.get(kernel);
  console.log("kernel env keys:", kenv && Array.from((kenv as any).names?.keys?.() ?? []));
  console.log("kernel env lookup for m:", kenv?.lookupName("m"));
  console.log("kernel env lookup for x:", kenv?.lookupName("x"));

  // Walk to find first `m` read.
  const allOperands: any[] = [];
  const stack: any[] = [rhs];
  while (stack.length) {
    const n = stack.pop();
    if (n instanceof ExprNS.Binary) { stack.push(n.right, n.left); continue; }
    if (n instanceof ExprNS.Variable) allOperands.push(n);
  }
  const mRead = allOperands.find(n => n.name?.lexeme === "m");
  console.log("m reads in RHS:", allOperands.filter(n => n.name?.lexeme === "m").length);
  console.log("i reads in RHS:", allOperands.filter(n => n.name?.lexeme === "i").length);
  if (!mRead) throw new Error("no m read found");

  const blk = wl.blockOfNode(mRead.id)!;
  const staticT = readExprFact(wl.factStore, typeAnalysis, blk, mRead.id);
  const specT = readExprFact(wl.factStore, speculativeTypeAnalysis, blk, mRead.id);
  console.log("static type at m read:", staticT);
  console.log("speculative type at m read:", specT);

  // Also check static and spec type at the x read (post-observation).
  const blkX = wl.blockOfNode(xRead.id)!;
  console.log("static type at x read:", readExprFact(wl.factStore, typeAnalysis, blkX, xRead.id));
  console.log("spec type at x read:", readExprFact(wl.factStore, speculativeTypeAnalysis, blkX, xRead.id));

  // Walk slot info via the block transfer.
  const assignNode = kernel.body[0] as StmtNS.Assign;
  console.log("assign target:", (assignNode.target as any).name?.lexeme);

  // Compile and print kernel's opcodes
  const compiler = SVMLCompiler.fromProgramUnit(ast, environments, makeDfaQuery(wl.factStore, wl.nodeIndex), wl.registry);
  const prog = compiler.compileProgram(ast);
  const kernelFn = prog.functions[1];
  console.log("\nKernel opcodes:");
  for (let i = 0; i < kernelFn.count; i++) {
    const op = OpCodes[kernelFn.opcodes[i]] ?? `?${kernelFn.opcodes[i]}`;
    console.log(`  [${i}] ${op} ${kernelFn.arg1s[i]} ${kernelFn.arg2s[i]}`);
  }
}

const baseline = compile(false);
const speculative = compile(true);

console.log("=== Opcode counts (kernel function only) ===");
const baseCounts = countOpcodes(baseline);
const specCounts = countOpcodes(speculative);
const interesting = ["ADDG", "ADDF", "MULG", "MULF", "LTG", "LTF", "GUARD_KIND"];
for (const op of interesting) {
  console.log(`  ${op.padEnd(12)} baseline=${baseCounts.get(op) ?? 0}  speculative=${specCounts.get(op) ?? 0}`);
}

console.log("\n=== Timing (5 runs each, best of 5) ===");
const time = (p: ReturnType<typeof compile>) => {
  const runs = [run(p), run(p), run(p), run(p), run(p)];
  return Math.min(...runs.map(r => r.ms));
};

// Warm V8.
for (let i = 0; i < 3; i++) { run(baseline); run(speculative); }

const tBase = time(baseline);
const tSpec = time(speculative);
console.log(`  baseline   : ${tBase.toFixed(2)} ms`);
console.log(`  speculative: ${tSpec.toFixed(2)} ms`);
console.log(`  speedup    : ${((tBase / tSpec - 1) * 100).toFixed(1)}%`);
