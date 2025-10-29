/**
 * Unit tests for SVML Interpreter
 * Converted from test-interpreter.ts manual tests to Jest test suite
 */

import { Parser } from "../parser";
import { Tokenizer } from "../tokenizer";
import { SVMLCompiler } from "../vm/svml-compiler";
import { SVMLBoxType } from "../vm/types";
import { SVMLInterpreter } from "../vm/svml-interpreter";
import { StmtNS } from "../ast-types";
import { UnsupportedOperandTypeError } from "../vm/errors";

/**
 * Helper function to parse Python code
 */
function parse(code: string): StmtNS.FileInput {
  const tokenizer = new Tokenizer(code);
  const tokens = tokenizer.scanEverything();
  const parser = new Parser(code, tokens);
  return parser.parse() as StmtNS.FileInput;
}

/**
 * Helper function to compile and run Python code
 */
function compileAndRun(code: string): SVMLBoxType {
  const ast = parse(code);
  const compiler = SVMLCompiler.fromProgram(ast);
  const program = compiler.compileProgram(ast);
  const instrumentation = compiler.getInstrumentation();
  const interpreter = new SVMLInterpreter(program, instrumentation);
  const result = interpreter.execute();

  return SVMLInterpreter.toJSValue(result);
}

describe('SVML Interpreter Tests', () => {
  describe('Basic Arithmetic', () => {
    test('Simple function addition', () => {
      const code = `
def add(x, y):
    return x + y

add(5, 3)
`;
      const result = compileAndRun(code);
      expect(result).toBe(8);
    });

    test('Multiple arithmetic operations', () => {
      const code = `
def calculate(a, b, c):
    return (a + b) * c - a

calculate(2, 3, 4)
`;
      const result = compileAndRun(code);
      expect(result).toBe(18); // (2 + 3) * 4 - 2 = 20 - 2 = 18
    });
  });

  describe('Recursive Functions', () => {
    test('Fibonacci sequence', () => {
      const code = `
def fibonacci(n):
    if n <= 1:
        return n
    else:
        return fibonacci(n - 1) + fibonacci(n - 2)

fibonacci(10)
`;
      const result = compileAndRun(code);
      expect(result).toBe(55);
    });

    test('Factorial calculation', () => {
      const code = `
def factorial(n):
    if n <= 1:
        return 1
    else:
        return n * factorial(n - 1)

factorial(5)
`;
      const result = compileAndRun(code);
      expect(result).toBe(120);
    });

    test('Ackermann function', () => {
      const code = `
def ackermann(m, n):
    if m == 0:
        return n + 1
    else:
        if n == 0:
            return ackermann(m - 1, 1)
        else:
            return ackermann(m - 1, ackermann(m, n - 1))

ackermann(3, 4)
`;
      const result = compileAndRun(code);
      expect(result).toBe(125);
    });
  });

  describe('Function Calls', () => {
    test('Nested function calls', () => {
      const code = `
def square(x):
    return x * x

def sum_of_squares(a, b):
    return square(a) + square(b)

sum_of_squares(3, 4)
`;
      const result = compileAndRun(code);
      expect(result).toBe(25); // 9 + 16 = 25
    });

    test('Multiple nested calls', () => {
      const code = `
def double(x):
    return x * 2

def triple(x):
    return x * 3

def combine(a, b):
    return double(a) + triple(b)

combine(5, 4)
`;
      const result = compileAndRun(code);
      expect(result).toBe(22); // 10 + 12 = 22
    });
  });

  describe('Mutual Recursion', () => {
    test('Even/odd mutual recursion', () => {
      const code = `
def is_even(n):
    if n == 0:
        return True
    else:
        return is_odd(n - 1)

def is_odd(n):
    if n == 0:
        return False
    else:
        return is_even(n - 1)

is_even(6)
`;
      const result = compileAndRun(code);
      expect(result).toBe(true);
    });

    test('Odd number check', () => {
      const code = `
def is_even(n):
    if n == 0:
        return True
    else:
        return is_odd(n - 1)

def is_odd(n):
    if n == 0:
        return False
    else:
        return is_even(n - 1)

is_odd(7)
`;
      const result = compileAndRun(code);
      expect(result).toBe(true);
    });
  });

  describe('Lambda Expressions', () => {
    test('Simple lambda function', () => {
      const code = `
def apply(f, x):
    return f(x)

double = lambda x: x * 2
apply(double, 5)
`;
      const result = compileAndRun(code);
      expect(result).toBe(10);
    });

    test('Lambda with multiple parameters', () => {
      const code = `
multiply = lambda x, y: x * y
multiply(6, 7)
`;
      const result = compileAndRun(code);
      expect(result).toBe(42);
    });
  });

  describe('Primitive Functions', () => {
    test('Absolute value function', () => {
      const code = `abs(-5)
`;
      const result = compileAndRun(code);
      expect(result).toBe(5);
    });

    test('Max function with multiple arguments', () => {
      const code = `max(3, 7, 2, 9)
`;
      const result = compileAndRun(code);
      expect(result).toBe(9);
    });

    test('Min function with multiple arguments', () => {
      const code = `min(3, 7, 2, 9)
`;
      const result = compileAndRun(code);
      expect(result).toBe(2);
    });
  });

  describe('Conditional Expressions', () => {
    test('Nested if-else conditions', () => {
      const code = `
def max_of_three(a, b, c):
    if a > b:
        if a > c:
            return a
        else:
            return c
    else:
        if b > c:
            return b
        else:
            return c

max_of_three(5, 9, 3)
`;
      const result = compileAndRun(code);
      expect(result).toBe(9);
    });

    test('Complex conditional logic', () => {
      const code = `
def classify_number(n):
    if n > 0:
        if n > 10:
            return "large positive"
        else:
            return "small positive"
    else:
        if n < -10:
            return "large negative"
        else:
            return "small negative or zero"

classify_number(15)
`;
      const result = compileAndRun(code);
      expect(result).toBe("large positive");
    });
  });

  describe('Error Handling', () => {
    test('String and number addition throws UnsupportedOperandTypeError', () => {
      const code = `
1+""
`;
      expect(() => compileAndRun(code)).toThrow(UnsupportedOperandTypeError);
    });
  });
});