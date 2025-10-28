import { SVMLCompiler } from "../vm/svml-compiler"
import { Tokenizer } from "../tokenizer"
import { Parser } from "../parser"
import { Resolver } from "../resolver"
import { runSVMLProgram } from "../vm/svml-interpreter"

export interface IOptions {
    isPrelude: boolean,
    envSteps: number,
    stepLimit: number
};

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
    code: string
): Promise<any> {
    const pyAst = parsePythonToAst(code, 1, true);
    const compiler = SVMLCompiler.fromProgram(pyAst);
    const program = compiler.compileProgram(pyAst);
    const result = runSVMLProgram(program, compiler.getInstrumentation());
    return Promise.resolve(result);
}