import { ExprNS, StmtNS } from "../../ast-types";
import { parse } from "../../parser/parser-adapter";
import { Resolver } from "../../resolver";
import { INT_BIT, STR_BIT } from "../../specialization/type-analysis/lattice";
import {
  Db,
  astOf,
  environmentsOf,
  runtimeWrite,
  typeOf,
} from "../../specialization/runtime";
import * as typeAnalysis from "../../specialization/type-analysis/analysis";
import { makeValidatorsForChapter } from "../../validator";

function setupUnit(code: string): { db: Db; ast: StmtNS.FileInput } {
  const script = code.endsWith("\n") ? code : code + "\n";
  const ast = parse(script);
  const resolver = new Resolver(script, ast, makeValidatorsForChapter(4));
  const errors = resolver.resolve(ast);
  if (errors.length > 0) throw errors[0];
  const db = new Db();
  astOf.set(db, 0, ast);
  environmentsOf.set(db, 0, resolver.functionEnvironments);
  return { db, ast };
}

function assignValueOf(ast: StmtNS.FileInput, index: number): ExprNS.Expr {
  const stmt = ast.statements[index] as StmtNS.Assign;
  return stmt.value;
}

describe("runtime/queries/typeOf", () => {
  test("literal int: id of `5` in `x = 5` has INT bit set", () => {
    const { db, ast } = setupUnit("x = 5");
    const lit = assignValueOf(ast, 0) as ExprNS.Literal;
    const t = db.get(typeOf, lit.id);
    expect(t.kinds & INT_BIT).toBe(INT_BIT);
  });

  test("variable read after assignment: `x` reference in `y = x` has INT bit set", () => {
    const { db, ast } = setupUnit(["x = 5", "y = x"].join("\n"));
    const xRef = assignValueOf(ast, 1) as ExprNS.Variable;
    const t = db.get(typeOf, xRef.id);
    expect(t.kinds & INT_BIT).toBe(INT_BIT);
  });

  test("memoization: two consecutive gets return the same value", () => {
    const { db, ast } = setupUnit("x = 5");
    const lit = assignValueOf(ast, 0) as ExprNS.Literal;
    const first = db.get(typeOf, lit.id);
    const second = db.get(typeOf, lit.id);
    expect(second).toBe(first);
  });

  test("invalidation on runtimeWrite: observation widens the literal's type", () => {
    const { db, ast } = setupUnit("x = 5");
    const lit = assignValueOf(ast, 0) as ExprNS.Literal;
    const before = db.get(typeOf, lit.id);
    expect(before.kinds & STR_BIT).toBe(0);

    runtimeWrite.set(db, lit.id, "observed");
    const after = db.get(typeOf, lit.id);
    expect(after.kinds & STR_BIT).toBe(STR_BIT);
  });

  test("early cutoff: re-asserting same observation does not re-run the replay", () => {
    const { db, ast } = setupUnit("x = 5");
    const lit = assignValueOf(ast, 0) as ExprNS.Literal;
    runtimeWrite.set(db, lit.id, 42);
    db.get(typeOf, lit.id);

    const spy = jest.spyOn(typeAnalysis, "nodeTypeFactsForBlock");
    runtimeWrite.set(db, lit.id, 42);
    db.get(typeOf, lit.id);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test("node id not in program returns BOTTOM", () => {
    const { db } = setupUnit("x = 5");
    const t = db.get(typeOf, 999999);
    expect(t.kinds).toBe(0);
  });
});
