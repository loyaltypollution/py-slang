import { StmtNS } from "../../ast-types";
import { parse } from "../../parser/parser-adapter";
import { Resolver } from "../../resolver";
import {
  type BasicBlock,
  type CFG,
} from "../../specialization/framework/cfg";
import { MutableEnv } from "../../specialization/framework/mutable-env";
import { type ConstLattice } from "../../specialization/const-analysis/lattice";
import {
  INT_BIT,
  STR_BIT,
  type TypeLattice,
} from "../../specialization/type-analysis/lattice";
import {
  Db,
  astOf,
  environmentsOf,
  runtimeWrite,
  typeBlockEnvs,
  constBlockEnvs,
} from "../../specialization/runtime";
import * as typeAnalysisModule from "../../specialization/type-analysis/analysis";
import { makeValidatorsForChapter } from "../../validator";

function setupUnit(code: string): { db: Db; ast: StmtNS.FileInput } {
  const script = code.endsWith("\n") ? code : code + "\n";
  const ast = parse(script);
  // Chapter 4 permits reassignment; the if/else convergence test needs it.
  const resolver = new Resolver(script, ast, makeValidatorsForChapter(4));
  const errors = resolver.resolve(ast);
  if (errors.length > 0) throw errors[0];

  const db = new Db();
  astOf.set(db, 0, ast);
  environmentsOf.set(db, 0, resolver.functionEnvironments);
  return { db, ast };
}

// Pick any NodeId that actually appears in the program — we reach for
// `statements[0].id` for stability.
function firstStmtId(ast: StmtNS.FileInput): number {
  const first = ast.statements[0] as unknown as { id: number };
  return first.id;
}

describe("runtime/queries/typeBlockEnvs", () => {
  test("trivial single-block program: x = 1 → exit env has x as int", () => {
    const { db } = setupUnit("x = 1");
    const envs = db.get(typeBlockEnvs, 0);

    // Entry + exit blocks at minimum. The final OUT env (exit block) should
    // have slot 0 set to an int-kinded value.
    expect(envs.size).toBeGreaterThanOrEqual(1);

    // Scan all blocks for slot-0 assignment; it must be int-kinded.
    let observedKind = 0;
    for (const env of envs.values()) {
      const v = env.get(0);
      if (v !== undefined) observedKind |= v.kinds;
    }
    expect(observedKind & INT_BIT).toBe(INT_BIT);
  });

  test("if/else convergence: y joined to int | string at the merge point", () => {
    // Distinct names per branch — the validator rejects reassignment across
    // branches, so the widening we exercise happens at the post-if join.
    // The assigned slot (`z`) ends up with a may-type of int-or-string
    // because both predecessors' OUTs join into the successor block.
    const { db } = setupUnit([
      "c = True",
      "z = 0",
      "if c:",
      "    z = 2",
      "else:",
      "    z = 'a'",
    ].join("\n"));
    const envs = db.get(typeBlockEnvs, 0);

    // y lives in some slot; find any env whose slot contains both INT and STR.
    let merged: TypeLattice | undefined;
    for (const env of envs.values()) {
      for (let slot = 0; slot < 8; slot++) {
        const v = env.get(slot);
        if (v === undefined) continue;
        if ((v.kinds & INT_BIT) && (v.kinds & STR_BIT)) {
          merged = v;
        }
      }
    }
    expect(merged).toBeDefined();
    expect(merged!.kinds & INT_BIT).toBe(INT_BIT);
    expect(merged!.kinds & STR_BIT).toBe(STR_BIT);
  });

  test("memoization: two consecutive gets return the same map reference", () => {
    const { db } = setupUnit("x = 1");
    const first = db.get(typeBlockEnvs, 0);
    const second = db.get(typeBlockEnvs, 0);
    expect(second).toBe(first);
  });

  test("invalidation: runtimeWrite.set on a reachable node triggers recompute", () => {
    const spy = jest.spyOn(typeAnalysisModule, "transferBlockWithObservations");
    const { db, ast } = setupUnit("x = 1");
    db.get(typeBlockEnvs, 0);
    const baseline = spy.mock.calls.length;
    expect(baseline).toBeGreaterThan(0);

    runtimeWrite.set(db, firstStmtId(ast), "observed");
    db.get(typeBlockEnvs, 0);
    expect(spy.mock.calls.length).toBeGreaterThan(baseline);
    spy.mockRestore();
  });

  test("early cutoff: re-asserting the same observation is a no-op", () => {
    const spy = jest.spyOn(typeAnalysisModule, "transferBlockWithObservations");
    const { db, ast } = setupUnit("x = 1");
    const id = firstStmtId(ast);
    runtimeWrite.set(db, id, 42);
    db.get(typeBlockEnvs, 0);
    const baseline = spy.mock.calls.length;

    // Same value — lattice-equal, so writeInput short-circuits and no
    // recompute fires downstream.
    runtimeWrite.set(db, id, 42);
    db.get(typeBlockEnvs, 0);
    expect(spy.mock.calls.length).toBe(baseline);
    spy.mockRestore();
  });
});

describe("runtime/queries/constBlockEnvs", () => {
  test("x = 5 → exit env has x as const(5)", () => {
    const { db } = setupUnit("x = 5");
    const envs = db.get(constBlockEnvs, 0);

    let found: ConstLattice | undefined;
    for (const env of envs.values()) {
      const v = env.get(0);
      if (v !== undefined && v.tag === "const") found = v;
    }
    expect(found).toBeDefined();
    expect(found!.tag).toBe("const");
    if (found!.tag === "const") expect(found!.value).toBe(5);
  });
});

// Iteration-cap coverage lives in `runtime/semi-naive.test.ts` (the
// evaluator exposes the same iteration-cap semantics as the former
// standalone kildall helper).

