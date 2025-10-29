import { SVMLCompiler } from "../vm/svml-compiler"
import { Tokenizer } from "../tokenizer"
import { Parser } from "../parser"
import { Resolver } from "../resolver"
import { SVMLInterpreter } from "../vm/svml-interpreter"
import { SVMLBoxType } from "../vm/types"

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
): Promise<{result: SVMLBoxType, stdout: string}> {
    const pyAst = parsePythonToAst(code, 1, true);
    const compiler = SVMLCompiler.fromProgram(pyAst);
    const program = compiler.compileProgram(pyAst);

    const instrumentation = compiler.getInstrumentation();
    const interpreter = new SVMLInterpreter(program, instrumentation);
    const result = interpreter.execute();
    const interpreterStdout = interpreter.getStdout();
    return Promise.resolve({result, stdout: interpreterStdout});
}