import OpCodes from "../../engines/svml/opcodes";
import { runSpecCase } from "./harness/spec-e2e";

// Binary op specialization: monomorphic-FLOAT loop body must pick F-opcodes,
// while the unoptimized baseline still uses G-opcodes. Table-driven so new
// operators drop in as a single row.
//
// These tests use float literals (1.0, 10.0, ...) because F-variants read
// operands as JS `number` at runtime. Int literals are bigint post-refactor
// and must stay on the G-path (which dispatches on typeof); there is no
// int-specialized opcode family yet — see DFA soundness audit item 4.
describe("specialization: float binary ops in while loops", () => {
  // Seed s at 1.0 so algebraic simplification can't collapse `s * i` to 0
  // via the `s=0 ⇒ 0*anything=0` rewrite; the test's intent is opcode
  // specialization, not preservation of the op against other optimizers.
  const WHILE_BODY = (op: string, guard: string) => `
i = 1.0
s = 1.0
while i ${guard} 10.0:
    s = s ${op} i
    i = i + 1.0
s
`;

  test.each([
    ["+", OpCodes.ADDF, OpCodes.ADDG],
    ["-", OpCodes.SUBF, OpCodes.SUBG],
    ["*", OpCodes.MULF, OpCodes.MULG],
    ["%", OpCodes.MODF, OpCodes.MODG],
    ["//", OpCodes.FLOORDIVF, OpCodes.FLOORDIVG],
  ] as const)("op %s selects %p, drops %p", (op, specialized, generic) => {
    runSpecCase(`while-body ${op}`, {
      code: WHILE_BODY(op, "<"),
      checks: [{ kind: "specialized", specialized, generic }],
    });
  });

  // Ascending (i=0.0 → limit): <, <=, !=
  // Descending (i=10.0 → 0.0): >, >=
  const ascending = `
i = 0.0
while i GUARD LIMIT:
    i = i + 1.0
i
`;
  const descending = `
i = 10.0
while i GUARD 0.0:
    i = i - 1.0
i
`;

  test.each([
    ["<", OpCodes.LTF, OpCodes.LTG, ascending, "10.0"],
    ["<=", OpCodes.LEF, OpCodes.LEG, ascending, "10.0"],
    ["!=", OpCodes.NEQF, OpCodes.NEQG, ascending, "10.0"],
    [">", OpCodes.GTF, OpCodes.GTG, descending, "0.0"],
    [">=", OpCodes.GEF, OpCodes.GEG, descending, "0.0"],
  ] as const)(
    "guard %s selects %p, drops %p",
    (guard, specialized, generic, template, limit) => {
      const code = template.replace("GUARD", guard).replace("LIMIT", limit);
      runSpecCase(`while-guard ${guard}`, {
        code,
        checks: [{ kind: "specialized", specialized, generic }],
      });
    },
  );

  test("eq inside branch: EQF over EQG", () => {
    runSpecCase("eq-branch", {
      code: `
i = 0.0
found = 0.0
while i < 10.0:
    if i == 5.0:
        found = 1.0
    i = i + 1.0
found
`,
      checks: [{ kind: "specialized", specialized: OpCodes.EQF, generic: OpCodes.EQG }],
    });
  });
});

// Unary specialization
describe("specialization: unary ops", () => {
  test("negation in typed loop body: NEGF over NEGG", () => {
    runSpecCase("neg-loop", {
      code: `
i = 5.0
s = 0.0
while i > 0.0:
    s = s + -i
    i = i - 1.0
s
`,
      checks: [{ kind: "specialized", specialized: OpCodes.NEGF, generic: OpCodes.NEGG }],
    });
  });

  test("boolean not on typed variable: NOTB over NOTG", () => {
    runSpecCase("not-bool-loop", {
      code: `
b = True
while b:
    b = not b
b
`,
      checks: [{ kind: "specialized", specialized: OpCodes.NOTB, generic: OpCodes.NOTG }],
    });
  });
});

// Negative assertion: types the optimizer cannot prove stay generic.
describe("specialization: unknown types remain generic", () => {
  test("function params are TOP → body uses ADDG, never ADDF", () => {
    runSpecCase("fn-params-generic", {
      code: `
def add(x, y):
    return x + y
add(3, 4)
`,
      checks: [
        { kind: "present", opcode: OpCodes.ADDG },
        { kind: "absent", opcode: OpCodes.ADDF },
      ],
    });
  });

  // The pre-refactor version of this test asserted that `fib(n - 1) + …`
  // specialized its subtractions to SUBF after narrowing `n` via `n <= 1`.
  // That only worked because INT and FLOAT both lived in JS `number`, so
  // F-variants handled either. Post-refactor SUBF requires pure FLOAT; the
  // narrowing `n <= 1.0` cannot prove `n` is float (Python allows mixed-type
  // compare), so the subtractions correctly stay on SUBG. Reinstating SUBF
  // here needs call-return type inference or an explicit type guard
  // mechanism — see DFA soundness audit item 4.
  test("recursive fib: body subtractions stay generic without call-return inference", () => {
    runSpecCase("fib-no-narrowing", {
      code: `
def fib(n):
    if n <= 1.0:
        return n
    return fib(n - 1.0) + fib(n - 2.0)
fib(10.0)
`,
      checks: [
        { kind: "present", opcode: OpCodes.ADDG }, // outer + over function returns
        { kind: "present", opcode: OpCodes.SUBG }, // n - 1.0 / n - 2.0 (n's type is TOP)
        { kind: "present", opcode: OpCodes.LEG }, // n <= 1.0 sees un-narrowed n
        { kind: "absent", opcode: OpCodes.ADDF },
        { kind: "absent", opcode: OpCodes.SUBF },
        { kind: "absent", opcode: OpCodes.LEF },
      ],
    });
  });
});
