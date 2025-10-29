import {
    Expression,
    Statement,
} from "estree";

import {Tokenizer} from '../tokenizer';
import {Parser} from '../parser';
import {Resolver} from '../resolver';
import {StmtNS} from "../ast-types";
import Stmt = StmtNS.Stmt;

export function toPythonAst(text: string): Stmt {
    const script = text + '\n'
    const tokenizer = new Tokenizer(script)
    const tokens = tokenizer.scanEverything()
    const pyParser = new Parser(script, tokens)
    const ast = pyParser.parse()
    // console.dir(ast);
    return ast;
}

export function toPythonAstAndResolve(text: string): Stmt {
    const ast = toPythonAst(text);
    new Resolver(text, ast).resolve(ast);
    return ast;
}