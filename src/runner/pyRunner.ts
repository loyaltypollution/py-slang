import { Context } from "../cse-machine/context"
import { CSEResultPromise, evaluate } from "../cse-machine/interpreter"
import init from "../sinter/sinter"
import { RecursivePartial, Result } from "../types"
import * as es from 'estree'
import { parsePythonToEstreeAst } from "../utils/ast/pythonParser"
import { compileDirect } from "../vm/svml-compiler"
import { assemble } from "../vm/svml-assembler"

export interface IOptions {
    isPrelude: boolean,
    envSteps: number,
    stepLimit: number
};

export async function runInContext(
    code: string,
    context: Context,
    options: RecursivePartial<IOptions> = {}
): Promise<Result> {
    const estreeAst: es.Program = parsePythonToEstreeAst(code, 1, true);
    // Compile to SVML
    const p = compileDirect(estreeAst);
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