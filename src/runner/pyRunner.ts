import { Context } from "../cse-machine/context"
import { CSEResultPromise, evaluate } from "../cse-machine/interpreter"
import init from "../sinter/sinter"
import { RecursivePartial, Result } from "../types"
import * as es from 'estree'
import { compileAll } from "../vm/svml-compiler"
import { Tokenizer } from "../tokenizer"
import { Parser } from "../parser"
import { Resolver } from "../resolver"
import { assemble } from "../vm/svml-assembler"

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
    // Compile to SVML
    const p = compileAll(pyAst);
    const binary: Uint8Array = assemble(p);
    const sinter = await init();
    var result: any = sinter.runBinary(binary);
    return CSEResultPromise(context, result);
    // var result = runCSEMachine(code, estreeAst, context, options);
    // return result;
}

export function runCSEMachine(code: string, program: es.Program, context: Context, options: RecursivePartial<IOptions> = {}): Promise<Result> {
    const result = evaluate(code, program, context, options);
    return CSEResultPromise(context, result);
}