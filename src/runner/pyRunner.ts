import { Context } from "../cse-machine/context"
import { CSEResultPromise, evaluate } from "../cse-machine/interpreter"
import { RecursivePartial, Result } from "../types"
import * as es from 'estree'
import { SVMLCompiler } from "../vm/svml-compiler"
import { Tokenizer } from "../tokenizer"
import { Parser } from "../parser"
import { Resolver } from "../resolver"
import { runSVMLProgram, convertToValue } from "../vm/svml-interpreter"

export interface IOptions {
    isPrelude: boolean,
    envSteps: number,
    stepLimit: number
};

/**
 * Parse Python code to Python AST without translation to ESTree
 */
function parsePythonToAst(code: string, variant: number = 1, doValidate: boolean = false): any {
    const script = code + '\n'
    const tokenizer = new Tokenizer(script)
    const tokens = tokenizer.scanEverything()
    const pyParser = new Parser(script, tokens)
    const ast = pyParser.parse()
    if (doValidate) {
        new Resolver(script, ast).resolve(ast);
    }
    return ast
}

export async function runInContext(
    code: string,
    context: Context,
    options: RecursivePartial<IOptions> = {}
): Promise<Result> {
    const pyAst = parsePythonToAst(code, 1, true);
    const compiler = SVMLCompiler.fromProgram(pyAst);
    const program = compiler.compileProgram(pyAst);
    const result = runSVMLProgram(program, compiler.getInstrumentation());
    const convertedResult = convertToValue(result);
    return CSEResultPromise(context, convertedResult);
    // var result = runCSEMachine(code, estreeAst, context, options);
    // return result;
}

export interface IOptions {
  isPrelude: boolean;
  envSteps: number;
  stepLimit: number;
}

function parsePythonToEstreeAst(
  code: string,
  variant: number = 1,
  doValidate: boolean = false
): Program {
  const script = code + "\n";
  const tokenizer = new Tokenizer(script);
  const tokens = tokenizer.scanEverything();
  const pyParser = new Parser(script, tokens);
  const ast = pyParser.parse();
  if (doValidate) {
    new Resolver(script, ast).resolve(ast);
  }
  const translator = new Translator(script);
  return translator.resolve(ast) as unknown as Program;
}

export async function runInContext(
  code: string,
  context: Context,
  options: RecursivePartial<IOptions> = {}
): Promise<Result> {
  const estreeAst = parsePythonToEstreeAst(code, 1, true);
  const result = runCSEMachine(code, estreeAst, context, options);
  return result;
}

export function runCSEMachine(
  code: string,
  program: es.Program,
  context: Context,
  options: RecursivePartial<IOptions> = {}
): Promise<Result> {
  const result = evaluate(code, program, context, options);
  return CSEResultPromise(context, result);
}
