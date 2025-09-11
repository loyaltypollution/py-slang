import type es from 'estree'

import {
  type Node,
  type StatementSequence
} from '../../cse-machine/types'

export const getVariableDeclarationName = (decl: es.VariableDeclaration) =>
  (decl.declarations[0].id as es.Identifier).name

export const locationDummyNode = (line: number, column: number, source: string | null) =>
  literal('Dummy', { start: { line, column }, end: { line, column }, source })

export const identifier = (name: string, loc?: es.SourceLocation | null): es.Identifier => ({
  type: 'Identifier',
  name,
  loc
})

export const literal = (
  value: string | number | boolean | null,
  loc?: es.SourceLocation | null
): es.Literal => ({
  type: 'Literal',
  value,
  loc
})

export const constantDeclaration = (
  name: string,
  init: es.Expression,
  loc?: es.SourceLocation | null
): es.VariableDeclaration => ({
  type: 'VariableDeclaration',
  declarations: [
    {
      type: 'VariableDeclarator',
      id: identifier(name),
      init
    }
  ],
  kind: 'const',
  loc
})

export const expressionStatement = (expression: es.Expression): es.ExpressionStatement => ({
  type: 'ExpressionStatement',
  expression
})

export const blockStatement = (
  body: es.Statement[],
  loc?: es.SourceLocation | null
): es.BlockStatement => ({
  type: 'BlockStatement',
  body,
  loc
})

export const statementSequence = (
  body: es.Statement[],
  loc?: es.SourceLocation | null
): StatementSequence => ({
  type: 'StatementSequence',
  body,
  loc
})

export const program = (body: es.Statement[]): es.Program => ({
  type: 'Program',
  sourceType: 'module',
  body
})

export const returnStatement = (
  argument: es.Expression,
  loc?: es.SourceLocation | null
): es.ReturnStatement => ({
  type: 'ReturnStatement',
  argument,
  loc
})

export const conditionalExpression = (
  test: es.Expression,
  consequent: es.Expression,
  alternate: es.Expression,
  loc?: es.SourceLocation | null
): es.ConditionalExpression => ({
  type: 'ConditionalExpression',
  test,
  consequent,
  alternate,
  loc
})

export const arrowFunctionExpression = (
  params: es.Pattern[],
  body: es.Expression | es.BlockStatement,
  loc?: es.SourceLocation | null
): es.ArrowFunctionExpression => ({
  type: 'ArrowFunctionExpression',
  expression: body.type !== 'BlockStatement',
  generator: false,
  params,
  body,
  loc
})

export const whileStatement = (
  body: es.BlockStatement,
  test: es.Expression,
  loc?: es.SourceLocation | null
): es.WhileStatement => ({
  type: 'WhileStatement',
  test,
  body,
  loc
})

// primitive: undefined is a possible value
export const primitive = (value: any): es.Expression => {
  return value === undefined ? identifier('undefined') : literal(value)
}