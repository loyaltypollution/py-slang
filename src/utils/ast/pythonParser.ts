import { Program } from "estree"
import { Parser } from "../../parser"
import { Tokenizer } from "../../tokenizer"
import { Resolver } from "../../resolver"
import { Translator } from "../../translator"

export function parsePythonToEstreeAst(code: string,
    variant: number = 1,
    doValidate: boolean = false): Program {
    const script = code + '\n'
    const tokenizer = new Tokenizer(script)
    const tokens = tokenizer.scanEverything()
    const pyParser = new Parser(script, tokens)
    const ast = pyParser.parse()
    if (doValidate) {
        new Resolver(script, ast).resolve(ast);
    }
    const translator = new Translator(script)
    return translator.resolve(ast) as unknown as Program
}