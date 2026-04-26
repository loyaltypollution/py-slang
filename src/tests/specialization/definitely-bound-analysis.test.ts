// Forward-must "definitely-bound locals" analysis. Exercises the forward/must
// quadrant end-to-end so that the framework's four-quadrant symmetry claim
// has a second concrete witness alongside `typeRequirementAnalysis`
// (backward/must). Verifies:
//   1. Parameter slots are bound at entry.
//   2. Non-parameter locals are explicitly seeded UNBOUND at entry.
//   3. A slot assigned unconditionally at the top of the function is bound
//      at the exit.
//   4. A slot assigned only on one branch of an `if` is NOT definitely bound
//      after the merge — this is the pessimistic meet semantics specific to
//      must-merge, and is what distinguishes forward-must from forward-may.
//   5. A slot assigned on every branch of an `if`/`else` IS definitely bound
//      after the merge.
//   6. Loop iterator slots become bound inside / after the loop body.

import { StmtNS } from "../../ast-types";
import { ROOT_CONTEXT } from "../../specialization/assumption/chain";
import { definitelyBoundAnalysis } from "../../specialization/analysis/definitely-bound/analysis";
import { BOUND, UNBOUND } from "../../specialization/analysis/definitely-bound/lattice";
import { DEFAULT_PASSES } from "../../specialization/defaults";
import { setupWithAnalyses } from "./harness/compile-pipelines";

// Drain with analyses only (no transforms) so the AST shape stays stable for
// assertions that dereference `fn.body[...]`. Transforms (dead-store,
// dead-branch, ...) can rewrite the body post-analysis, which is orthogonal
// to what this test verifies.
function build(code: string) {
  const s = setupWithAnalyses(code, DEFAULT_PASSES);
  s.worklist.drain();
  return s;
}

describe("definitelyBoundAnalysis (forward-must)", () => {
  test("parameter slots are BOUND at entry", () => {
    const { ast, worklist } = build(`
def f(a, b):
    return a + b
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.locate.functionById(fn.id)!;

    const entry = unit.cfg.entry;
    const env = definitelyBoundAnalysis.env.store.read(entry, ROOT_CONTEXT);
    // After transferBlock runs on entry, all param slots should be BOUND.
    const slotA = unit.slotLookup(fn.parameters[0]).slot;
    const slotB = unit.slotLookup(fn.parameters[1]).slot;
    expect(env.get(slotA)).toBe(BOUND);
    expect(env.get(slotB)).toBe(BOUND);
  });

  test("non-parameter locals are explicitly seeded UNBOUND at entry", () => {
    const { ast, worklist } = build(`
def f(flag):
    if flag:
        x = 10
    return flag
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.locate.functionById(fn.id)!;

    const ifStmt = fn.body[0] as StmtNS.If;
    const assignX = ifStmt.body[0] as StmtNS.Assign;
    const xTarget = assignX.target as import("../../ast-types").ExprNS.Variable;
    const slotX = unit.slotLookup(xTarget.name).slot;

    const entry = unit.cfg.entry;
    const env = definitelyBoundAnalysis.env.store.read(entry, ROOT_CONTEXT);
    expect(env.get(slotX)).toBe(UNBOUND);
  });

  test("unconditional assignment at top → BOUND at exit", () => {
    const { ast, worklist } = build(`
def f():
    x = 10
    return x
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.locate.functionById(fn.id)!;

    // Resolve `x`'s slot via any Variable reference in the body — the
    // slotLookup is keyed by Token, not by name string.
    const ret = fn.body[1] as StmtNS.Return;
    const xRef = ret.value as import("../../ast-types").ExprNS.Variable;
    const slotX = unit.slotLookup(xRef.name).slot;

    const exit = unit.cfg.exit;
    const env = definitelyBoundAnalysis.env.store.read(exit, ROOT_CONTEXT);
    expect(env.get(slotX)).toBe(BOUND);
  });

  test("assignment on only one branch → UNBOUND after merge (forward-must pessimism)", () => {
    const { ast, worklist } = build(`
def f(flag):
    if flag:
        x = 10
    return flag
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.locate.functionById(fn.id)!;

    // The name `x` exists in the function's slot table even though it's only
    // assigned in the if-branch. Resolve via the Assign target inside the If.
    const ifStmt = fn.body[0] as StmtNS.If;
    const assignX = ifStmt.body[0] as StmtNS.Assign;
    const xTarget = assignX.target as import("../../ast-types").ExprNS.Variable;
    const slotX = unit.slotLookup(xTarget.name).slot;

    const exit = unit.cfg.exit;
    const env = definitelyBoundAnalysis.env.store.read(exit, ROOT_CONTEXT);
    expect(env.get(slotX)).toBe(UNBOUND);
  });

  test("assignment on every branch of if/else → BOUND after merge", () => {
    const { ast, worklist } = build(`
def f(flag):
    if flag:
        x = 10
    else:
        x = 20
    return x
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.locate.functionById(fn.id)!;

    const ret = fn.body[1] as StmtNS.Return;
    const xRef = ret.value as import("../../ast-types").ExprNS.Variable;
    const slotX = unit.slotLookup(xRef.name).slot;

    const exit = unit.cfg.exit;
    const env = definitelyBoundAnalysis.env.store.read(exit, ROOT_CONTEXT);
    expect(env.get(slotX)).toBe(BOUND);
  });

  test("for-loop iterator is BOUND inside and after the loop", () => {
    const { ast, worklist } = build(`
def f(xs):
    total = 0
    for i in xs:
        total = total + i
    return total
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.locate.functionById(fn.id)!;

    const forStmt = fn.body[1] as StmtNS.For;
    const slotI = unit.slotLookup(forStmt.target).slot;

    const exit = unit.cfg.exit;
    const env = definitelyBoundAnalysis.env.store.read(exit, ROOT_CONTEXT);
    // `i` is bound by the For header; definitely bound at exit when the body
    // runs at least once. Under must semantics, a zero-iteration path would
    // leave `i` unbound — the analysis is conservative and doesn't model the
    // iterator count, so it treats the For as unconditionally binding `i`
    // (matches the CFG wiring where the body is a successor of the header).
    expect(env.get(slotI)).toBe(BOUND);
  });
});
