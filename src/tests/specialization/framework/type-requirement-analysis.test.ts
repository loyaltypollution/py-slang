// Must-backward type-requirement analysis. Ships the fourth classical DFA
// quadrant — backward direction, must-merge — driven by the return-kind
// narrowing dimension. Verifies:
//   1. Under ROOT (no return-kind assumption) every slot's requirement is
//      TOP — the analysis is sound-no-op when speculation isn't active.
//   2. With a manually-built return-kind assumption, `return x` seeds the
//      parameter slot at the entry block, reproducible via
//      `requirementAtEntry`.
//   3. Assignment kill semantics: `y = x; return y` hoists the requirement
//      past the assignment onto `x`'s slot; `y`'s slot is cleared.
//   4. Binary-op inverse: `return x + 1` with an int return-kind
//      assumption requires `x` to be int at entry (kind-level).
//   5. End-to-end pipeline: `observeRuntimeReturn` under `immediateStrategy`
//      extends the unit's context and the analysis populates entry-block
//      requirements automatically.
//   6. `observationSource` guardrail: a write observation does not extend
//      any return-kind assumption, even when key-spaces could be confused.

import { ExprNS, StmtNS } from "../../../ast-types";
import { parse } from "../../../parser/parser-adapter";
import { analyzeWithEnvironments } from "../../../resolver";
import {
  extendContext,
  findAssumption,
  ROOT_CONTEXT,
} from "../../../specialization/framework/context";
import {
  observeRuntimeReturn,
  observeRuntimeWrite,
} from "../../../specialization/framework/runtime-analyses";
import {
  INT_BIT,
  INT_POS,
} from "../../../specialization/type-analysis/lattice";
import {
  requirementAtEntry,
  returnKindHandle,
  typeRequirementAnalysis,
} from "../../../specialization/type-requirement-analysis/analysis";
import { Worklist } from "../../../specialization/framework/worklist";

function build(code: string): { ast: StmtNS.FileInput; worklist: Worklist } {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const worklist = new Worklist(ast, environments);
  worklist.drain();
  return { ast, worklist };
}

describe("typeRequirementAnalysis (must-backward)", () => {
  test("ROOT context: no return-kind assumption → no requirement at entry", () => {
    const { ast, worklist } = build(`
def hot(x):
    return x
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.units.get(fn)!;

    const reqs = requirementAtEntry(worklist.factStore, unit, ROOT_CONTEXT);
    expect(reqs.size).toBe(0);
  });

  test("return x with INT_POS return-kind assumption requires x: INT_POS at entry", () => {
    const { ast, worklist } = build(`
def hot(x):
    return x
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.units.get(fn)!;

    const ctx = extendContext(ROOT_CONTEXT, returnKindHandle, fn.id, INT_POS);
    worklist.enqueue(typeRequirementAnalysis, unit.cfg.exit, ctx);
    worklist.drain();

    const reqs = requirementAtEntry(worklist.factStore, unit, ctx);
    expect(reqs.get(0)).toEqual(INT_POS);
  });

  test("intermediate assignment: y = x; return y hoists onto x, clears y", () => {
    const { ast, worklist } = build(`
def hot(x):
    y = x
    return y
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.units.get(fn)!;

    const ctx = extendContext(ROOT_CONTEXT, returnKindHandle, fn.id, INT_POS);
    worklist.enqueue(typeRequirementAnalysis, unit.cfg.exit, ctx);
    worklist.drain();

    const reqs = requirementAtEntry(worklist.factStore, unit, ctx);
    // Slot 0 = parameter `x`; non-zero slot(s) = locals. `x` carries the
    // requirement; `y` is killed by its own assignment before the backward
    // flow reaches the entry block.
    expect(reqs.get(0)).toEqual(INT_POS);
    for (const [slot, _req] of reqs) {
      if (slot !== 0) {
        throw new Error(`unexpected requirement on non-param slot ${slot}`);
      }
    }
  });

  test("binary + with int target requires both operands int (kind-level)", () => {
    const { ast, worklist } = build(`
def hot(x):
    return x + 1
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.units.get(fn)!;

    const ctx = extendContext(ROOT_CONTEXT, returnKindHandle, fn.id, INT_POS);
    worklist.enqueue(typeRequirementAnalysis, unit.cfg.exit, ctx);
    worklist.drain();

    const reqs = requirementAtEntry(worklist.factStore, unit, ctx);
    const xReq = reqs.get(0);
    // Kind mask constrained to INT; sign inverse is deferred — the first-cut
    // propagator widens sign to INT_ANY so the target's sign refinement does
    // NOT carry into operand requirements. `x`'s kind must be int.
    expect(xReq?.kinds).toBe(INT_BIT);
  });

  test("end-to-end: observeRuntimeReturn extends context and seeds entry requirement", () => {
    const { ast, worklist } = build(`
def hot(x):
    return x
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.units.get(fn)!;

    // Immediate strategy is the default — a single observation extends the
    // context on the first liftable value.
    observeRuntimeReturn(worklist, fn.id, 7);
    worklist.drain();

    const ctx = worklist.specContextFor(unit);
    expect(ctx).not.toBe(ROOT_CONTEXT);
    expect(findAssumption(ctx, returnKindHandle, fn.id)).toBeDefined();

    const reqs = requirementAtEntry(worklist.factStore, unit, ctx);
    expect(reqs.get(0)?.kinds).toBe(INT_BIT);
  });

  test("write observation does NOT extend return-kind context", () => {
    // The observationSource filter is what prevents cross-narrowing
    // triggering. A write observation at a node inside `hot` must not
    // attach a returnKindHandle assumption at any fdId — only the
    // typeNarrowing / constNarrowing (both sourced from
    // runtimeWriteAnalysis) may respond.
    const { ast, worklist } = build(`
def hot(x):
    return x
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.units.get(fn)!;
    const retStmt = fn.body[0] as StmtNS.Return;
    const xRead = retStmt.value as ExprNS.Variable;

    observeRuntimeWrite(worklist, xRead.id, 5);
    worklist.drain();

    const ctx = worklist.specContextFor(unit);
    expect(findAssumption(ctx, returnKindHandle, fn.id)).toBeUndefined();
  });
});
