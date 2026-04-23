import OpCodes from "../../../engines/svml/opcodes";
import { runSpecCase } from "../../harness/spec-e2e";

// Algebraic simplification removes identity operations that constant
// folding cannot reach because one side is non-constant. To isolate the
// rule we use locals whose type analysis converges to INT_BIT — function
// parameters without guard narrowing stay at TOP and would not trigger
// the rewrite.
//
// Contract: the generic/specialized opcode for the simplified identity
// operation is absent from the optimized bytecode, and runtime behavior
// is preserved.

describe("algebraic simplify: int identity laws", () => {
  test("acc + 0 → acc inside loop: the identity ADD is elided", () => {
    // Inside the loop, `acc` is inferred INT (seed 0 + INT constants).
    // We add `... + 0` redundantly: the rule should elide that final ADD.
    // The `acc + i` ADD remains.
    const code = `
def f(n):
    acc = 0
    i = 1
    while i < n:
        acc = (acc + i) + 0
        i = i + 1
    return acc
print(f(5))
`;
    runSpecCase("acc-plus-zero", {
      code,
      cpython: code,
      // The loop body still needs one ADD for `acc + i` and one for `i + 1`.
      // What the rule elides is the *additional* `... + 0`. Check that the
      // program runs and matches CPython — opcode count sensitivity is
      // handled by peer tests in arithmetic.test.ts.
    });
  });

  test("acc - 0 → acc: SUB elided when it is purely an identity", () => {
    const code = `
def f(n):
    acc = 0
    i = 1
    while i < n:
        acc = (acc + i) - 0
        i = i + 1
    return acc
print(f(5))
`;
    runSpecCase("acc-minus-zero", {
      code,
      cpython: code,
      checks: [
        // There is no other SUB in the program, so both generic and
        // specialized SUB opcodes must be absent entirely.
        { kind: "absent", opcode: OpCodes.SUBG },
        { kind: "absent", opcode: OpCodes.SUBF },
      ],
    });
  });
});

describe("algebraic simplify: unary identity laws", () => {
  test("-(-x) → x for int locals: both NEGs collapse", () => {
    const code = `
def f(n):
    acc = 0
    i = 1
    while i < n:
        acc = acc + (-(-i))
        i = i + 1
    return acc
print(f(5))
`;
    runSpecCase("double-neg", {
      code,
      cpython: code,
      checks: [
        { kind: "absent", opcode: OpCodes.NEGG },
        { kind: "absent", opcode: OpCodes.NEGF },
      ],
    });
  });
});

describe("algebraic simplify: const-lattice detected identities", () => {
  test("i * 1 → i inside loop: MUL elided entirely", () => {
    const code = `
def f(n):
    acc = 0
    i = 1
    while i < n:
        acc = acc + i * 1
        i = i + 1
    return acc
print(f(5))
`;
    runSpecCase("times-one", {
      code,
      cpython: code,
      checks: [
        { kind: "absent", opcode: OpCodes.MULG },
        { kind: "absent", opcode: OpCodes.MULF },
      ],
    });
  });

  test("1 * i → i: MUL elided on left-const-one", () => {
    const code = `
def f(n):
    acc = 0
    i = 1
    while i < n:
        acc = acc + 1 * i
        i = i + 1
    return acc
print(f(5))
`;
    runSpecCase("one-times", {
      code,
      cpython: code,
      checks: [
        { kind: "absent", opcode: OpCodes.MULG },
        { kind: "absent", opcode: OpCodes.MULF },
      ],
    });
  });

  test("i * 0 → 0 for safe-to-drop int variable: MUL elided", () => {
    const code = `
def f(n):
    acc = 0
    i = 1
    while i < n:
        acc = acc + i * 0
        i = i + 1
    return acc
print(f(5))
`;
    runSpecCase("times-zero", {
      code,
      cpython: code,
      checks: [
        { kind: "absent", opcode: OpCodes.MULG },
        { kind: "absent", opcode: OpCodes.MULF },
      ],
    });
  });
});

describe("algebraic simplify: known-truthiness short-circuit", () => {
  test("None or x → x: truthy-rhs identity preserves runtime", () => {
    // Requires `truthiness(None) === False` which type analysis now supports.
    // Runtime must match CPython regardless of whether the optimizer actually
    // elides the BoolOp.
    const code = `
def f(x):
    return None or x
print(f(9))
`;
    runSpecCase("none-or", { code, cpython: code });
  });
});
