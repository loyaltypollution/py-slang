import { runSpecCase } from "../../harness/spec-e2e";

// Guard narrowing: type-analysis's `refineOnEdge` narrows a slot's type on
// branch edges of `if slot OP literal`. The downstream effect is that
// comparisons / arithmetic inside the branch see a sharpened type, which
// const-folding + dead-branch + specialization collapse.

describe("guard narrowing: `if x > 0` branch sees x as positive", () => {
  // Inside the true branch, `x > 0` narrows x to INT_POS. The nested
  // `x > 0` check therefore folds to True, and the `return -1` arm
  // becomes dead.
  test("redundant inner x>0 check folds out", () => {
    const code = `
def f(x):
    if x > 0:
        if x > 0:
            return 1
        return -1
    return 0
print(f(5))
print(f(-5))
print(f(0))
`;
    runSpecCase("nested-positive-check", {
      code,
      cpython: code,
    });
  });
});

describe("guard narrowing: elif after x > 0 narrows to non-positive", () => {
  // False branch of `x > 0` gives x: NonPos. Inside the elif, `x < 0`
  // reduces to ⊤ (could be zero or negative), so no folding of the elif
  // itself. But the elif's *else* branch has NonPos ⊓ NonNeg = Zero, so
  // the final `return 0` sees x narrowed to INT_ZERO.
  test("three-way classifier behaves correctly", () => {
    const code = `
def classify(x):
    if x > 0:
        return 1
    elif x < 0:
        return -1
    else:
        return 0
print(classify(7))
print(classify(-3))
print(classify(0))
`;
    runSpecCase("classify", {
      code,
      cpython: code,
    });
  });
});

describe("guard narrowing: arithmetic inside narrowed branch preserves semantics", () => {
  // `x > 0` narrows x to INT_POS in type analysis. Whether that narrowing
  // reaches the SVML specializer depends on runtime observations too, so
  // this test only asserts semantic equality to CPython — the opcode-shape
  // assertion belongs in a combined type+runtime integration test.
  test("x * 2 inside `if x > 0:` preserves runtime semantics", () => {
    const code = `
def f(x):
    if x > 0:
        return x * 2
    return 0
print(f(5))
print(f(-3))
`;
    runSpecCase("pos-mul", { code, cpython: code });
  });
});

describe("guard narrowing: literal-on-left swaps op", () => {
  // `0 < x` is `x > 0` after swap — must narrow the same way.
  test("0 < x inside if narrows x to INT_POS", () => {
    const code = `
def f(x):
    if 0 < x:
        if x > 0:
            return 1
    return 0
print(f(5))
print(f(-5))
`;
    runSpecCase("literal-left-lt", {
      code,
      cpython: code,
    });
  });
});

describe("guard narrowing: not-condition flips branches", () => {
  test("`not (x > 0)` on true branch narrows to NonPos", () => {
    const code = `
def f(x):
    if not (x > 0):
        if x > 0:
            return 999
        return 1
    return 2
print(f(5))
print(f(-5))
print(f(0))
`;
    runSpecCase("not-cond", {
      code,
      cpython: code,
    });
  });
});

describe("guard narrowing: non-refinable predicates do not narrow", () => {
  // `x > -5` gives no sign refinement (slot could be any of -4, 0, 5).
  // Runtime must still be correct.
  test("x > -5 remains unrefined; behavior preserved", () => {
    const code = `
def f(x):
    if x > -5:
        return x
    return -999
print(f(3))
print(f(-10))
`;
    runSpecCase("unrefinable-gt-neg", {
      code,
      cpython: code,
    });
  });
});
