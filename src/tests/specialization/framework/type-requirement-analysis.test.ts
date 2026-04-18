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
import { MutableEnv } from "../../../specialization/framework/mutable-env";
import {
  observeRuntimeReturn,
  observeRuntimeWrite,
} from "../../../specialization/framework/runtime-analyses";
import {
  BOTTOM,
  INT_BIT,
  INT_NEG,
  INT_POS,
  meet,
  type TypeLattice,
} from "../../../specialization/type-analysis/lattice";
import {
  requirementAtEntry,
  returnKindHandle,
  typeRequirementAnalysis,
  type EntryRequirement,
} from "../../../specialization/type-requirement-analysis/analysis";
import type { SpeculationStrategy } from "../../../specialization/framework/speculation-strategy";
import {
  DEFAULT_PASSES,
  DEFAULT_TRANSFORMS,
  Worklist,
} from "../../../specialization/framework/worklist";

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
    expect(reqs.provable.size).toBe(0);
    expect(reqs.unprovable.size).toBe(0);
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
    expect(reqs.provable.get(0)).toEqual(INT_POS);
    expect(reqs.unprovable.size).toBe(0);
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
    expect(reqs.provable.get(0)).toEqual(INT_POS);
    for (const slot of reqs.provable.keys()) {
      if (slot !== 0) {
        throw new Error(`unexpected requirement on non-param slot ${slot}`);
      }
    }
    expect(reqs.unprovable.size).toBe(0);
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
    const xReq = reqs.provable.get(0);
    // Kind mask constrained to INT; sign inverse is deferred — the first-cut
    // propagator widens sign to INT_ANY so the target's sign refinement does
    // NOT carry into operand requirements. `x`'s kind must be int.
    expect(xReq?.kinds).toBe(INT_BIT);
    expect(reqs.unprovable.size).toBe(0);
  });

  test.each([
    ["x * 2"],
    ["x - 1"],
    ["x // 2"],
    ["x % 3"],
  ])("binary %s with int target requires x: int at entry", (rhs) => {
    const { ast, worklist } = build(`
def hot(x):
    return ${rhs}
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.units.get(fn)!;

    const ctx = extendContext(ROOT_CONTEXT, returnKindHandle, fn.id, INT_POS);
    worklist.enqueue(typeRequirementAnalysis, unit.cfg.exit, ctx);
    worklist.drain();

    const reqs = requirementAtEntry(worklist.factStore, unit, ctx);
    expect(reqs.provable.get(0)?.kinds).toBe(INT_BIT);
    expect(reqs.unprovable.size).toBe(0);
  });

  test("binary / is NOT int-closed — no requirement on operands", () => {
    // Python 3: int / int = float. The backward inverse `result int ⇒
    // operands int` would be unsound here; the analysis must leave the
    // operand unconstrained at entry.
    const { ast, worklist } = build(`
def hot(x):
    return x / 2
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.units.get(fn)!;

    const ctx = extendContext(ROOT_CONTEXT, returnKindHandle, fn.id, INT_POS);
    worklist.enqueue(typeRequirementAnalysis, unit.cfg.exit, ctx);
    worklist.drain();

    const reqs = requirementAtEntry(worklist.factStore, unit, ctx);
    expect(reqs.provable.size).toBe(0);
    expect(reqs.unprovable.size).toBe(0);
  });

  test("ternary: target propagates into both arms", () => {
    const { ast, worklist } = build(`
def hot(x, y, c):
    return x if c else y
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.units.get(fn)!;

    const ctx = extendContext(ROOT_CONTEXT, returnKindHandle, fn.id, INT_POS);
    worklist.enqueue(typeRequirementAnalysis, unit.cfg.exit, ctx);
    worklist.drain();

    const reqs = requirementAtEntry(worklist.factStore, unit, ctx);
    // Parameters are slots 0 (x), 1 (y), 2 (c). Both x and y must be int;
    // the predicate c carries no requirement because the predicate type
    // doesn't flow into the result.
    expect(reqs.provable.get(0)?.kinds).toBe(INT_BIT);
    expect(reqs.provable.get(1)?.kinds).toBe(INT_BIT);
    expect(reqs.provable.get(2)).toBeUndefined();
    expect(reqs.unprovable.size).toBe(0);
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
    expect(reqs.provable.get(0)?.kinds).toBe(INT_BIT);
    expect(reqs.unprovable.size).toBe(0);
  });

  test("unsatisfiable requirements classify as unprovable, not provable", () => {
    // The current propagator rules rarely produce unsatisfiable entries
    // from source code (all paths seeded by the same returnKindHandle
    // target widen to INT_ANY on int-closed binops). Inject the two
    // unsatisfiable shapes directly and verify the split classifies them:
    //   - slot 10: full BOTTOM (kinds === 0).
    //   - slot 11: meet(INT_POS, INT_NEG) — kinds=INT_BIT but intRef=0,
    //     i.e. int kind with no admissible sign. Structurally non-BOTTOM
    //     but semantically admits no value; `isSatisfiable` must see this.
    //   - slot 12: INT_POS, provable.
    const { ast, worklist } = build(`
def hot(x):
    return x
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.units.get(fn)!;

    const ctx = extendContext(ROOT_CONTEXT, returnKindHandle, fn.id, INT_POS);
    const env = new MutableEnv<TypeLattice>();
    env.set(10, BOTTOM);
    env.set(11, meet(INT_POS, INT_NEG));
    env.set(12, INT_POS);
    worklist.factStore.write(
      typeRequirementAnalysis,
      unit.cfg.entry,
      { outEnv: env, exprFacts: new Map<number, TypeLattice>() },
      ctx,
    );

    const reqs = requirementAtEntry(worklist.factStore, unit, ctx);
    expect(reqs.unprovable.has(10)).toBe(true);
    expect(reqs.unprovable.has(11)).toBe(true);
    expect(reqs.provable.get(12)).toEqual(INT_POS);
    expect(reqs.provable.has(10)).toBe(false);
    expect(reqs.provable.has(11)).toBe(false);
  });

  test("ObservationEvent.requirementsAt reports entry requirement under parent context", () => {
    // First observation: parentContext is ROOT, analysis hasn't seeded,
    // requirementsAt() returns empty. Strategy accepts, context extends
    // to INT_POS, entry requirement populates. Second observation on the
    // same fdId with the same value is idempotent (no further extension)
    // but still calls the strategy — at which point parentContext is the
    // extended chain and requirementsAt() reflects the populated fact.
    const seen: EntryRequirement[] = [];
    const strategy: SpeculationStrategy = {
      onObservation(event) {
        seen.push(event.requirementsAt());
        return true;
      },
    };

    const script = "def hot(x):\n    return x + 1\n";
    const ast = parse(script) as StmtNS.FileInput;
    const { environments } = analyzeWithEnvironments(ast, script, 4);
    const worklist = new Worklist(
      ast,
      environments,
      DEFAULT_PASSES,
      undefined,
      DEFAULT_TRANSFORMS,
      strategy,
    );
    worklist.drain();

    const fn = ast.statements[0] as StmtNS.FunctionDef;

    observeRuntimeReturn(worklist, fn.id, 7);
    worklist.drain();
    observeRuntimeReturn(worklist, fn.id, 7);
    worklist.drain();

    expect(seen).toHaveLength(2);
    expect(seen[0].provable.size).toBe(0);
    expect(seen[0].unprovable.size).toBe(0);
    expect(seen[1].provable.get(0)?.kinds).toBe(INT_BIT);
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
