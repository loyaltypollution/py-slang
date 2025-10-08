/**
 * Test file demonstrating the complete SVML compilation and interpretation pipeline
 * with instrumentation and memoization
 */

import { Parser } from "../parser";
import { Tokenizer } from "../tokenizer";
import { SVMLCompiler } from "./svml-compiler";
import { SVMLInterpreter, runSVMLProgram } from "./svml-interpreter";
import { InstrumentationTracker } from "./instrumentation";
import { StmtNS } from "../ast-types";
import { stringifyProgram } from '../vm/util';
import fs from "fs";

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
 * Test 1: Simple arithmetic
 */
export function testSimpleArithmetic() {
  console.log("\n" + "=".repeat(70));
  console.log("TEST 1: Simple Arithmetic");
  console.log("=".repeat(70));

  const code = `
def add(x, y):
    return x + y

add(5, 3)
`;

  const ast = parse(code);
  const compiler = SVMLCompiler.fromProgram(ast);
  const program = compiler.compileProgram(ast);
  
  const result = runSVMLProgram(program, compiler.getInstrumentation());
  console.log(`Result: ${SVMLInterpreter.toJSValue(result)}`);
}

/**
 * Test 2: Recursive Fibonacci (demonstrates recursion detection)
 */
export function testFibonacci() {
  console.log("\n" + "=".repeat(70));
  console.log("TEST 2: Recursive Fibonacci (with Memoization)");
  console.log("=".repeat(70));

  const code = `
def fibonacci(n):
    if n <= 1:
        return n
    else:
        return fibonacci(n - 1) + fibonacci(n - 2)

fibonacci(10)
`;

  const ast = parse(code);
  const compiler = SVMLCompiler.fromProgram(ast);
  const program = compiler.compileProgram(ast);
  
  // Save the program to a file
  const outputFile = 'fibonacci.svml';
  const outputContent = stringifyProgram(program);
  fs.writeFileSync(outputFile, outputContent);

  console.log("\nExecuting Fibonacci(10)...");
  const startTime = Date.now();
  const result = runSVMLProgram(program, compiler.getInstrumentation());
  const endTime = Date.now();
  
  console.log(`Result: ${SVMLInterpreter.toJSValue(result)}`);
  console.log(`Execution time: ${endTime - startTime}ms`);
  console.log(`Expected: 55`);
}

/**
 * Test 3: Factorial (another recursive function)
 */
export function testFactorial() {
  console.log("\n" + "=".repeat(70));
  console.log("TEST 3: Recursive Factorial");
  console.log("=".repeat(70));

  const code = `
def factorial(n):
    if n <= 1:
        return 1
    else:
        return n * factorial(n - 1)

factorial(5)
`;

  const ast = parse(code);
  const compiler = SVMLCompiler.fromProgram(ast);
  const program = compiler.compileProgram(ast);
  
  const result = runSVMLProgram(program, compiler.getInstrumentation());
  console.log(`Result: ${SVMLInterpreter.toJSValue(result)}`);
  console.log(`Expected: 120`);
}

/**
 * Test 4: Nested function calls
 */
export function testNestedCalls() {
  console.log("\n" + "=".repeat(70));
  console.log("TEST 4: Nested Function Calls");
  console.log("=".repeat(70));

  const code = `
def square(x):
    return x * x

def sum_of_squares(a, b):
    return square(a) + square(b)

sum_of_squares(3, 4)
`;

  const ast = parse(code);
  const compiler = SVMLCompiler.fromProgram(ast);
  const program = compiler.compileProgram(ast);
  
  const result = runSVMLProgram(program, compiler.getInstrumentation());
  console.log(`Result: ${SVMLInterpreter.toJSValue(result)}`);
  console.log(`Expected: 25 (9 + 16)`);
}

/**
 * Test 5: Mutual recursion detection
 */
export function testMutualRecursion() {
  console.log("\n" + "=".repeat(70));
  console.log("TEST 5: Mutual Recursion Detection");
  console.log("=".repeat(70));

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

  const ast = parse(code);
  const compiler = SVMLCompiler.fromProgram(ast);
  const program = compiler.compileProgram(ast);
  
  const result = runSVMLProgram(program, compiler.getInstrumentation());
  console.log(`Result: ${SVMLInterpreter.toJSValue(result)}`);
  console.log(`Expected: True`);
}

/**
 * Test 6: Lambda expressions
 */
export function testLambda() {
  console.log("\n" + "=".repeat(70));
  console.log("TEST 6: Lambda Expressions");
  console.log("=".repeat(70));

  const code = `
def apply(f, x):
    return f(x)

double = lambda x: x * 2
apply(double, 5)
`;

  const ast = parse(code);
  const compiler = SVMLCompiler.fromProgram(ast);
  const program = compiler.compileProgram(ast);
  
  const result = runSVMLProgram(program, compiler.getInstrumentation());
  console.log(`Result: ${SVMLInterpreter.toJSValue(result)}`);
  console.log(`Expected: 10`);
}

/**
 * Test 7: Primitive functions
 */
export function testPrimitives() {
  console.log("\n" + "=".repeat(70));
  console.log("TEST 7: Primitive Functions");
  console.log("=".repeat(70));

  const code = `
x = abs(-5)
y = max(3, 7, 2, 9)
z = min(3, 7, 2, 9)
`;

  const ast = parse(code);
  const compiler = SVMLCompiler.fromProgram(ast);
  const program = compiler.compileProgram(ast);
  
  const result = runSVMLProgram(program, compiler.getInstrumentation());
  console.log(`Result: ${SVMLInterpreter.toJSValue(result)}`);
}

/**
 * Test 8: Conditional expressions
 */
export function testConditionals() {
  console.log("\n" + "=".repeat(70));
  console.log("TEST 8: Conditional Expressions");
  console.log("=".repeat(70));

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

  const ast = parse(code);
  const compiler = SVMLCompiler.fromProgram(ast);
  const program = compiler.compileProgram(ast);
  
  const result = runSVMLProgram(program, compiler.getInstrumentation());
  console.log(`Result: ${SVMLInterpreter.toJSValue(result)}`);
  console.log(`Expected: 9`);
}

/**
 * Test 9: Performance comparison - Fibonacci with and without memoization
 */
export function testMemoizationPerformance() {
  console.log("\n" + "=".repeat(70));
  console.log("TEST 9: Memoization Performance (Fibonacci)");
  console.log("=".repeat(70));

  const code = `
def fibonacci(n):
    if n <= 1:
        return n
    else:
        return fibonacci(n - 1) + fibonacci(n - 2)

fibonacci(15)
`;

  const ast = parse(code);
  
  // Test with memoization
  console.log("\n--- With Memoization ---");
  const compilerWithMemo = SVMLCompiler.fromProgram(ast);
  const programWithMemo = compilerWithMemo.compileProgram(ast);
  
  const startWithMemo = Date.now();
  const resultWithMemo = runSVMLProgram(programWithMemo, compilerWithMemo.getInstrumentation());
  const endWithMemo = Date.now();
  const statsWithMemo = new SVMLInterpreter(programWithMemo, compilerWithMemo.getInstrumentation()).execute();
  
  console.log(`Result: ${SVMLInterpreter.toJSValue(resultWithMemo)}`);
  console.log(`Time: ${endWithMemo - startWithMemo}ms`);
  
  // Test without memoization (by creating a fresh instrumentation with memoization disabled)
  console.log("\n--- Without Memoization ---");
  const instrumentationNoMemo = new InstrumentationTracker({
    enableMemoization: false,
    enableRecursionDetection: true,
    logRecursiveCalls: false,
  });
  const compilerNoMemo = new SVMLCompiler(
    compilerWithMemo['currentEnvironment'],
    compilerWithMemo['functionEnvironments'],
    compilerWithMemo['builder'],
    instrumentationNoMemo
  );
  const programNoMemo = compilerNoMemo.compileProgram(ast);
  
  const startNoMemo = Date.now();
  const resultNoMemo = runSVMLProgram(programNoMemo, instrumentationNoMemo);
  const endNoMemo = Date.now();
  
  console.log(`Result: ${SVMLInterpreter.toJSValue(resultNoMemo)}`);
  console.log(`Time: ${endNoMemo - startNoMemo}ms`);
  
  const speedup = ((endNoMemo - startNoMemo) / (endWithMemo - startWithMemo)).toFixed(2);
  console.log(`\nSpeedup with memoization: ${speedup}x`);
}

/**
 * Test 10: Complex recursion - Ackermann function
 */
export function testAckermann() {
  console.log("\n" + "=".repeat(70));
  console.log("TEST 10: Ackermann Function (Complex Recursion)");
  console.log("=".repeat(70));

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

  const ast = parse(code);
  const compiler = SVMLCompiler.fromProgram(ast);
  const program = compiler.compileProgram(ast);
  
  console.log("\nExecuting Ackermann(3, 4)...");
  const startTime = Date.now();
  const result = runSVMLProgram(program, compiler.getInstrumentation());
  const endTime = Date.now();
  
  console.log(`Result: ${SVMLInterpreter.toJSValue(result)}`);
  console.log(`Execution time: ${endTime - startTime}ms`);
  console.log(`Expected: 125`);
}

/**
 * Run all tests
 */
export function runAllTests() {
  console.log("\n");
  console.log("█".repeat(70));
  console.log("  SVML INTERPRETER TEST SUITE");
  console.log("  Testing: Compilation → Interpretation → Instrumentation");
  console.log("█".repeat(70));

  try {
    testSimpleArithmetic();
    testFibonacci();
    testFactorial();
    testNestedCalls();
    testMutualRecursion();
    testLambda();
    testPrimitives();
    testConditionals();
    testMemoizationPerformance();
    testAckermann();

    console.log("\n" + "█".repeat(70));
    console.log("  ✓ ALL TESTS COMPLETED SUCCESSFULLY");
    console.log("█".repeat(70) + "\n");
  } catch (error) {
    console.error("\n" + "█".repeat(70));
    console.error("  ✗ TEST FAILED");
    console.error("█".repeat(70));
    console.error(error);
  }
}

// Run tests if this file is executed directly
if (require.main === module) {
  runAllTests();
}

