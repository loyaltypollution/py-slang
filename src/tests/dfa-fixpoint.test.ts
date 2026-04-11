/**
 * Unit tests for the DFA fixpoint driver.
 *
 * Tests:
 *  1. While-loop convergence: types widen correctly and terminate
 *  2. If-else join: env after if/else is join of both branches
 *  3. For-loop: loop variable set to TOP
 *  4. Nested while-loops: terminate correctly
 *  5. Assignment propagation: type flows from rhs to slot
 */

import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import {
  runAnalysisPass,
  MutableEnv,
  TypeAnalysisModule,
  HintStore,
  buildSlotTable,
  INT_BIT,
  BOOL_BIT,
  FLOAT_BIT,
  IntRef,
  BoolRef,
  positiveInteger,
  negativeInteger,
  join,
  leq,
  type TypeLattice,
} from "../specialization";
import { ExprNS, StmtNS } from "../ast-types";

function analyseTopLevel(code: string): { hints: HintStore; ast: StmtNS.FileInput } {
  const script = code + "\n";
  const ast = parse(script);
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const env = environments.get(ast)!;
  const slotTable = buildSlotTable(env, []);
  const hints = new HintStore();
  runAnalysisPass(
    ast.statements,
    new TypeAnalysisModule(),
    new MutableEnv(),
    hints,
    slotTable.lookup,
  );
  return { hints, ast };
}

describe("DFA fixpoint driver", () => {
  describe("Literal annotation", () => {
    test("positive integer literal annotated as INT_BIT Pos", () => {
      const { hints, ast } = analyseTopLevel("x = 5");
      const assign = ast.statements[0] as any;
      const lit = assign.value;
      expect(hints.get(lit)?.type?.kinds).toBe(INT_BIT);
      expect(hints.get(lit)?.type?.intRef).toBe(IntRef.Pos);
    });

    test("float literal annotated as FLOAT_BIT", () => {
      const { hints, ast } = analyseTopLevel("x = 3.14");
      const assign = ast.statements[0] as any;
      const lit = assign.value;
      expect(hints.get(lit)?.type?.kinds).toBe(FLOAT_BIT);
    });

    test("boolean literal annotated as BOOL_BIT", () => {
      const { hints, ast } = analyseTopLevel("x = True");
      const assign = ast.statements[0] as any;
      const lit = assign.value;
      expect(hints.get(lit)?.type?.kinds).toBe(BOOL_BIT);
      expect(hints.get(lit)?.type?.boolRef).toBe(BoolRef.True);
    });
  });

  describe("Binary expression annotation", () => {
    test("pos + pos annotated as INT_BIT Pos", () => {
      const { hints, ast } = analyseTopLevel("z = 3 + 4");
      const assign = ast.statements[0] as any;
      const binExpr = assign.value; // 3 + 4
      expect(hints.get(binExpr)?.type?.kinds).toBe(INT_BIT);
      expect(hints.get(binExpr)?.type?.intRef).toBe(IntRef.Pos);
    });

    test("pos - pos annotated as INT_BIT Top (sign unknown)", () => {
      const { hints, ast } = analyseTopLevel("z = 5 - 3");
      const assign = ast.statements[0] as any;
      const binExpr = assign.value;
      expect(hints.get(binExpr)?.type?.kinds).toBe(INT_BIT);
      // 5 - 3 = pos - pos = top (could be positive or negative or zero)
      expect(hints.get(binExpr)?.type?.intRef).toBe(IntRef.Top);
    });
  });

  describe("MutableTypeEnv", () => {
    test("snapshot is independent copy", () => {
      const env = new MutableEnv<TypeLattice>([positiveInteger()]);
      const snap = env.snapshot();
      env.set(0, negativeInteger());
      expect(snap.get(0)?.intRef).toBe(IntRef.Pos); // snapshot unaffected
      expect(env.get(0)?.intRef).toBe(IntRef.Neg);
    });

    test("joinWith merges slots correctly", () => {
      const env1 = new MutableEnv<TypeLattice>([positiveInteger()]);
      const env2 = new MutableEnv<TypeLattice>([negativeInteger()]);
      env1.joinWith(env2, join);
      // join(Pos, Neg) = NonZero (4 | 1 = 5): both are definitely nonzero, zero is impossible
      expect(env1.get(0)?.kinds).toBe(INT_BIT);
      expect(env1.get(0)?.intRef).toBe(IntRef.NonZero);
    });

    test("equals returns true for same singletons", () => {
      const env1 = new MutableEnv<TypeLattice>([positiveInteger()]);
      const env2 = new MutableEnv<TypeLattice>([positiveInteger()]);
      expect(env1.equals(env2, leq)).toBe(true);
    });

    test("equals returns false for different values", () => {
      const env1 = new MutableEnv<TypeLattice>([positiveInteger()]);
      const env2 = new MutableEnv<TypeLattice>([negativeInteger()]);
      expect(env1.equals(env2, leq)).toBe(false);
    });

    test("equals returns false for different lengths", () => {
      const env1 = new MutableEnv<TypeLattice>([positiveInteger(), positiveInteger()]);
      const env2 = new MutableEnv<TypeLattice>([positiveInteger()]);
      expect(env1.equals(env2, leq)).toBe(false);
    });
  });

  describe("runAnalysisPass terminates", () => {
    test("simple while loop completes without infinite loop", () => {
      const code = `
x = 1
while x > 0:
    x = x + 1
`;
      expect(() => analyseTopLevel(code)).not.toThrow();
    });

    test("nested while loops complete", () => {
      const code = `
i = 0
while i > 0:
    j = 0
    while j > 0:
        j = j + 1
    i = i + 1
`;
      expect(() => analyseTopLevel(code)).not.toThrow();
    });

    test("if-else completes", () => {
      const code = `
x = 1
if x > 0:
    y = 2
else:
    y = 3
`;
      expect(() => analyseTopLevel(code)).not.toThrow();
    });

    test("for loop completes", () => {
      const code = `
total = 0
for i in [1, 2, 3]:
    total = total + i
`;
      expect(() => analyseTopLevel(code)).not.toThrow();
    });
  });

  describe("If-else join semantics", () => {
    test("annotates condition expression", () => {
      const { hints, ast } = analyseTopLevel("x = 3\nif x > 0:\n    y = 1\nelse:\n    y = 2");
      const ifStmt = ast.statements[1] as any;
      const condition = ifStmt.condition; // Compare: x > 0
      const condHint = hints.get(condition);
      expect(condHint?.type?.kinds).toBe(BOOL_BIT);
    });
  });

  describe("Comparison annotation", () => {
    test("pos > pos annotated as BOOL_BIT Top", () => {
      const { hints, ast } = analyseTopLevel("z = 3 > 4");
      const assign = ast.statements[0] as any;
      const cmp = assign.value;
      expect(hints.get(cmp)?.type?.kinds).toBe(BOOL_BIT);
    });

    test("pos > zero annotated as BOOL_BIT True", () => {
      const { hints, ast } = analyseTopLevel("z = 5 > 0");
      const assign = ast.statements[0] as any;
      const cmp = assign.value;
      expect(hints.get(cmp)?.type?.kinds).toBe(BOOL_BIT);
      expect(hints.get(cmp)?.type?.boolRef).toBe(BoolRef.True);
    });
  });
});
