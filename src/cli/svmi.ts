#!/usr/bin/env node

import { Command } from "commander";
import { SVMLCompiler, SVMProgram } from "../vm";
import { disassemble } from "../vm/svml-assembler";
import { SVMLInterpreter } from "../vm/svml-interpreter";
import * as fs from "fs";
import { Parser } from "../parser";
import { Tokenizer } from "../tokenizer";
import { Resolver } from "../resolver";
import { StmtNS } from "../ast-types";
/**
 * Standalone function to parse Python to Python AST without translation to ESTree
 */
function parsePythonToAst(
  code: string,
  variant: number = 1,
  doValidate: boolean = false
): any {
  const script = code + "\n";
  const tokenizer = new Tokenizer(script);
  const tokens = tokenizer.scanEverything();
  const pyParser = new Parser(script, tokens);
  const ast = pyParser.parse() as StmtNS.FileInput;
  if (doValidate) {
    new Resolver(script, ast).resolve(ast);
  }
  const compiler = SVMLCompiler.fromProgram(ast);
  const program = compiler.compileProgram(ast);
  return program;
}

function interpretSVMProgram(program: SVMProgram) {
  try {
    console.log("Initializing SVML Interpreter with ", program);
    const interpreter = new SVMLInterpreter(program, undefined, {
      debug: true,
    });

    console.log("Executing program...", interpreter);
    const result = interpreter.execute();
    console.log("Execution result:", result);
  } catch (error) {
    console.error("Error interpreting SVM program:", error);
    if (error instanceof Error) {
      console.error("Stack trace:", error.stack);
    }
    process.exit(1);
  }
}

/**
 * CLI tool for interpreting Python code
 */
function main() {
  const program = new Command();

  program
    .name("svmi")
    .description("SVML Interpreter - Run SVM program")
    .version("1.0.0");

  program
    .command("interpret")
    .description("Interpret SVM program")
    .argument("<input-file>", "SVM program file to run")
    .action((inputFile: string) => {
      if (!fs.existsSync(inputFile)) {
        console.error(`Error: File '${inputFile}' not found`);
        process.exit(1);
      }

      try {
        const bin = fs.readFileSync(inputFile);
        const program = disassemble(bin);
        interpretSVMProgram(program);
      } catch (error) {
        console.error(`Error reading file '${inputFile}':`, error);
        process.exit(1);
      }
    });

  program
    .command("interpretPython")
    .description("Interpret Python code directly")
    .argument("<input-file>", "Python file to interpret")
    .action((inputFile: string) => {
      const pythonCode = fs.readFileSync(inputFile, "utf8");
      const program = parsePythonToAst(pythonCode, 1, true);
      interpretSVMProgram(program);
    });

  program.parse(process.argv);
}

// Run the CLI if this file is executed directly
if (require.main === module) {
  main();
}

export { interpretSVMProgram };
