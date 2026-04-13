import { ExprNS, StmtNS } from "../../ast-types";
import { parse } from "../../parser/parser-adapter";
import { Resolver } from "../../resolver";
import {
  Db,
  astOf,
  environmentsOf,
  constOf,
} from "../../specialization/runtime";
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

function findVariableReadById(
  ast: StmtNS.FileInput,
  name: string,
  inStmtAtIndex: number,
): ExprNS.Variable {
  const stmt = ast.statements[inStmtAtIndex] as StmtNS.Assign;
  // Walk the rhs for a Variable node with matching name.
  let found: ExprNS.Variable | undefined;
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (found) return;
    const obj = node as Record<string, unknown>;
    if (obj.kind === "Variable") {
      const tok = obj.name as { lexeme?: string } | undefined;
      if (tok && tok.lexeme === name) {
        found = obj as unknown as ExprNS.Variable;
        return;
      }
    }
    for (const key of Object.keys(obj)) {
      const child = obj[key];
      if (Array.isArray(child)) for (const item of child) walk(item);
      else if (typeof child === "object" && child !== null) walk(child);
    }
  };
  walk(stmt);
  if (!found) throw new Error(`no variable ${name} in stmt ${inStmtAtIndex}`);
  return found;
}

describe("runtime/queries/constOf", () => {
  test("literal const: `5` in `x = 5` is const(5)", () => {
    const { db, ast } = setupUnit("x = 5");
    const lit = (ast.statements[0] as StmtNS.Assign).value as ExprNS.Literal;
    const c = db.get(constOf, lit.id);
    expect(c.tag).toBe("const");
    if (c.tag === "const") expect(c.value).toBe(5);
  });

  test("top after if/else with disagreeing constants", () => {
    const { db, ast } = setupUnit(
      ["c = True", "x = 0", "if c:", "    x = 1", "else:", "    x = 2", "y = x"].join(
        "\n",
      ),
    );
    // The `x` reference in `y = x` is after the merge.
    const xRef = findVariableReadById(ast, "x", 3);
    const c = db.get(constOf, xRef.id);
    expect(c.tag).toBe("top");
  });

  test("bottom for node id not present in the program", () => {
    const { db } = setupUnit("x = 5");
    const c = db.get(constOf, 999999);
    expect(c.tag).toBe("bottom");
  });
});
