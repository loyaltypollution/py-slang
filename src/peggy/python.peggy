{{
  // Helper functions for AST construction
  function makeExpr(type, props, location) {
    return {
      type: `Expr.${type}`,
      startToken: { 
        line: location.start.line, 
        col: location.start.column,
        lexeme: '',
        type: null,
        indexInSource: location.start.offset 
      },
      endToken: { 
        line: location.end.line, 
        col: location.end.column,
        lexeme: '',
        type: null,
        indexInSource: location.end.offset 
      },
      ...props,
      accept(visitor: Visitor<any>): any {
        const methodName = `visit${type}Expr`;
        if (typeof visitor[methodName] === 'function') {
          return visitor[methodName](this);
        }
        throw new Error(`Visitor method ${methodName} not implemented`);
      }
    };
  }

  function makeBinaryExpr(left, rest, location) {
    return rest.reduce((acc, [op, right]) => {
      return makeExpr(
        "Binary",
        {
          left: acc,
          operator: op,
          right: right,
        },
        location,
      );
    }, left);
  }

  function makeStmt(type, props, location) {
    return {
      type: `Stmt.${type}`,
      startToken: { 
        line: location.start.line, 
        col: location.start.column,
        lexeme: '',
        type: null,
        indexInSource: location.start.offset 
      },
      endToken: { 
        line: location.end.line, 
        col: location.end.column,
        lexeme: '',
        type: null,
        indexInSource: location.end.offset 
      },
      ...props,
      accept(visitor: Visitor<any>): any {
        const methodName = `visit${type}Stmt`;
        if (typeof visitor[methodName] === 'function') {
          return visitor[methodName](this);
        }
        throw new Error(`Visitor method ${methodName} not implemented`);
      }
    };
  }
}}

// Start symbol
file_input
  = _ stmts:(stmt / NEWLINE)* _ EOF {
      return makeStmt(
        "FileInput",
        {
          statements: stmts.filter((s) => s && s.type),
          varDecls: [],
        },
        location(),
      );
    }

// Statements
stmt
  = simple_stmt
  / compound_stmt

simple_stmt
  = small:small_stmt (";" _ small_stmt)* ";"? NEWLINE { return small; }

small_stmt
  = assign_stmt
  / pass_stmt
  / flow_stmt
  / import_stmt
  / global_stmt
  / nonlocal_stmt
  / assert_stmt

assign_stmt
  = name:NAME _ ":" _ ann:test _ val:("=" _ test)? {
      return makeStmt(
        "AnnAssign",
        {
          name: name,
          value: val ? val[2] : null,
          ann: ann,
        },
        location(),
      );
    }
  / name:NAME _ "=" _ value:test {
      return makeStmt(
        "Assign",
        {
          name: name,
          value: value,
        },
        location(),
      );
    }

pass_stmt = PASS { return makeStmt("Pass", {}, location()); }

flow_stmt
  = break_stmt
  / continue_stmt
  / return_stmt

break_stmt = BREAK { return makeStmt("Break", {}, location()); }

continue_stmt = CONTINUE { return makeStmt("Continue", {}, location()); }

return_stmt
  = RETURN _ value:test? {
      return makeStmt("Return", { value: value || null }, location());
    }

import_stmt
  = FROM _ module:NAME _ IMPORT _ names:import_names {
      return makeStmt(
        "FromImport",
        { module: module, names: names },
        location(),
      );
    }

import_names
  = "(" _ names:name_list _ ")" { return names; }
  / name:NAME { return [name]; }

name_list
  = first:NAME rest:(_ "," _ NAME)* {
      return [first, ...rest.map((r) => r[3])];
    }

global_stmt
  = GLOBAL _ names:name_list {
      return makeStmt("Global", { name: names[0] }, location());
    }

nonlocal_stmt
  = NONLOCAL _ names:name_list {
      return makeStmt("NonLocal", { name: names[0] }, location());
    }

assert_stmt
  = ASSERT _ value:test {
      return makeStmt("Assert", { value: value }, location());
    }

// Compound statements
compound_stmt
  = if_stmt
  / while_stmt
  / for_stmt
  / funcdef

if_stmt
  = IF
    _
    condition:test
    _
    ":"
    _
    body:suite
    elifs:elif_part*
    else_block:else_part? {
      let result = makeStmt(
        "If",
        {
          condition: condition,
          body: body,
          elseBlock: else_block || (elifs.length > 0 ? [elifs[0]] : null),
        },
        location(),
      );

      // Chain elifs
      for (let i = 0; i < elifs.length; i++) {
        if (i === 0 && !else_block) {
          result.elseBlock = [elifs[i]];
        }
      }
      return result;
    }

elif_part
  = ELIF _ condition:test _ ":" _ body:suite {
      return makeStmt(
        "If",
        {
          condition: condition,
          body: body,
          elseBlock: null,
        },
        location(),
      );
    }

else_part = ELSE _ ":" _ body:suite { return body; }

while_stmt
  = WHILE _ condition:test _ ":" _ body:suite {
      return makeStmt(
        "While",
        {
          condition: condition,
          body: body,
        },
        location(),
      );
    }

for_stmt
  = FOR _ target:NAME _ IN _ iter:test _ ":" _ body:suite {
      return makeStmt(
        "For",
        {
          target: target,
          iter: iter,
          body: body,
        },
        location(),
      );
    }

funcdef
  = DEF _ name:NAME _ params:parameters _ ":" _ body:suite {
      return makeStmt(
        "FunctionDef",
        {
          name: name,
          parameters: params,
          body: body,
          varDecls: [],
        },
        location(),
      );
    }

parameters = "(" _ params:varargslist? _ ")" { return params || []; }

varargslist
  = first:NAME rest:(_ "," _ NAME)* {
      return [first, ...rest.map((r) => r[3])];
    }

suite
  = simple_stmt { return [text()]; }
  / NEWLINE INDENT stmts:stmt+ DEDENT { return stmts; }

// Test expressions (ternary, lambda, boolean operations)
test
  = or_test:or_test cond:(_ IF _ or_test _ ELSE _ test)? {
      if (cond) {
        return makeExpr(
          "Ternary",
          {
            predicate: cond[3],
            consequent: or_test,
            alternative: cond[7],
          },
          location(),
        );
      }
      return or_test;
    }
  / lambdef

lambdef
  = LAMBDA _ params:varargslist? _ body:lambda_body {
      if (body.isMulti) {
        return makeExpr(
          "MultiLambda",
          {
            parameters: params || [],
            body: body.stmts,
            varDecls: [],
          },
          location(),
        );
      }
      return makeExpr(
        "Lambda",
        {
          parameters: params || [],
          body: body.expr,
        },
        location(),
      );
    }

lambda_body
  = "::" _ suite:suite { return { isMulti: true, stmts: suite }; }
  / ":" _ expr:test { return { isMulti: false, expr: expr }; }

or_test
  = left:and_test rest:(_ OR _ and_test)* {
      return rest.reduce((acc, [_, op, __, right]) => {
        return makeExpr(
          "BoolOp",
          {
            left: acc,
            operator: op,
            right: right,
          },
          location(),
        );
      }, left);
    }

and_test
  = left:not_test rest:(_ AND _ not_test)* {
      return rest.reduce((acc, [_, op, __, right]) => {
        return makeExpr(
          "BoolOp",
          {
            left: acc,
            operator: op,
            right: right,
          },
          location(),
        );
      }, left);
    }

not_test
  = NOT _ expr:not_test {
      return makeExpr(
        "Unary",
        {
          operator: { type: "NOT", lexeme: "not" },
          right: expr,
        },
        location(),
      );
    }
  / comparison

comparison
  = left:arith_expr rest:(_ comp_op _ arith_expr)* {
      return rest.reduce((acc, [_, op, __, right]) => {
        return makeExpr(
          "Compare",
          {
            left: acc,
            operator: op,
            right: right,
          },
          location(),
        );
      }, left);
    }

comp_op
  = "<=" { return { type: "LESSEQUAL", lexeme: "<=" }; }
  / ">=" { return { type: "GREATEREQUAL", lexeme: ">=" }; }
  / "==" { return { type: "DOUBLEEQUAL", lexeme: "==" }; }
  / "!=" { return { type: "NOTEQUAL", lexeme: "!=" }; }
  / "<" { return { type: "LESS", lexeme: "<" }; }
  / ">" { return { type: "GREATER", lexeme: ">" }; }
  / IS _ NOT { return { type: "ISNOT", lexeme: "is not" }; }
  / IS { return { type: "IS", lexeme: "is" }; }
  / NOT _ IN { return { type: "NOTIN", lexeme: "not in" }; }
  / IN { return { type: "IN", lexeme: "in" }; }

arith_expr
  = left:term rest:(_ [+\-] _ term)* {
      return rest.reduce((acc, [_, op, __, right]) => {
        return makeExpr(
          "Binary",
          {
            left: acc,
            operator: { type: op === "+" ? "PLUS" : "MINUS", lexeme: op },
            right: right,
          },
          location(),
        );
      }, left);
    }

term
  = left:factor rest:(_ [*/%] _ factor)* {
      return rest.reduce((acc, [_, op, __, right]) => {
        const opType = op === "*" ? "STAR" : op === "/" ? "SLASH" : "PERCENT";
        return makeExpr(
          "Binary",
          {
            left: acc,
            operator: { type: opType, lexeme: op },
            right: right,
          },
          location(),
        );
      }, left);
    }

factor
  = op:[+\-~] _ expr:factor {
      const opType = op === "+" ? "PLUS" : op === "-" ? "MINUS" : "TILDE";
      return makeExpr(
        "Unary",
        {
          operator: { type: opType, lexeme: op },
          right: expr,
        },
        location(),
      );
    }
  / power

power
  = base:atom_expr exp:(_ "**" _ factor)? {
      if (exp) {
        return makeExpr(
          "Binary",
          {
            left: base,
            operator: { type: "DOUBLESTAR", lexeme: "**" },
            right: exp[3],
          },
          location(),
        );
      }
      return base;
    }

atom_expr
  = atom:atom args:arglist? {
      if (args) {
        return makeExpr(
          "Call",
          {
            callee: atom,
            args: args,
          },
          location(),
        );
      }
      return atom;
    }

atom
  = "(" _ expr:test _ ")" {
      return makeExpr("Grouping", { expression: expr }, location());
    }
  / NONE { return makeExpr("None", { value: "None" }, location()); }
  / TRUE { return makeExpr("Literal", { value: true }, location()); }
  / FALSE { return makeExpr("Literal", { value: false }, location()); }
  / NUMBER {
      const val = parseFloat(text());
      return makeExpr("Literal", { value: val }, location());
    }
  / BIGINT {
      return makeExpr(
        "BigIntLiteral",
        { value: text().slice(0, -1) },
        location(),
      );
    }
  / COMPLEX { return makeExpr("Complex", { value: text() }, location()); }
  / STRING {
      return makeExpr("Literal", { value: text().slice(1, -1) }, location());
    }
  / NAME { return makeExpr("Variable", { name: text() }, location()); }

arglist = "(" _ args:arg_list? _ ")" { return args || []; }

arg_list
  = first:test rest:(_ "," _ test)* {
      return [first, ...rest.map((r) => r[3])];
    }

// Tokens / Keywords
DEF = "def" !identifier_rest _

IF = "if" !identifier_rest _

ELIF = "elif" !identifier_rest _

ELSE = "else" !identifier_rest _

WHILE = "while" !identifier_rest _

FOR = "for" !identifier_rest _

IN = "in" !identifier_rest _

BREAK = "break" !identifier_rest _

CONTINUE = "continue" !identifier_rest _

RETURN = "return" !identifier_rest _

PASS = "pass" !identifier_rest _

LAMBDA = "lambda" !identifier_rest _

FROM = "from" !identifier_rest _

IMPORT = "import" !identifier_rest _

GLOBAL = "global" !identifier_rest _

NONLOCAL = "nonlocal" !identifier_rest _

ASSERT = "assert" !identifier_rest _

AND = "and" !identifier_rest _

OR = "or" !identifier_rest _

NOT = "not" !identifier_rest _

IS = "is" !identifier_rest _

TRUE = "True" !identifier_rest _

FALSE = "False" !identifier_rest _

NONE = "None" !identifier_rest _

// Forbidden keywords - will cause parse error if used as identifiers
FORBIDDEN
  = (
      "async"
      / "await"
      / "yield"
      / "with"
      / "del"
      / "try"
      / "except"
      / "finally"
      / "raise"
      / "class"
    )
    !identifier_rest

// Literals
BIGINT = [0-9]+ "n" _

COMPLEX = [0-9]+ ("." [0-9]+)? [jJ] _

NUMBER = [0-9]+ ("." [0-9]+)? ![jJn] _

STRING
  = "\"\"\"" chars:(!"\"\"\"" .)* "\"\"\"" _ { return text(); }
  / "'''" chars:(!"'''" .)* "'''" _ { return text(); }
  / "\"" chars:(!"\"" !"\n" .)* "\"" _ { return text(); }
  / "'" chars:(!"'" !"\n" .)* "'" _ { return text(); }

NAME
  = !FORBIDDEN !RESERVED name:identifier {
      return { type: "NAME", lexeme: name };
    }

RESERVED
  = DEF
  / IF
  / ELIF
  / ELSE
  / WHILE
  / FOR
  / IN
  / BREAK
  / CONTINUE
  / RETURN
  / PASS
  / LAMBDA
  / FROM
  / IMPORT
  / GLOBAL
  / NONLOCAL
  / ASSERT
  / AND
  / OR
  / NOT
  / IS
  / TRUE
  / FALSE
  / NONE

identifier = [a-zA-Z_] [a-zA-Z0-9_]* { return text(); }

identifier_rest = [a-zA-Z0-9_]

// Whitespace and indentation
// Note: This is simplified - Python's indentation is complex
// For POC, we use pseudo-tokens
INDENT
  = "    " { return text(); } // Simplified: 4 spaces

DEDENT
  = "" // Simplified

NEWLINE
  = "\r\n" _
  / "\n" _
  / "\r" _

_ "whitespace" = ([ \t] / comment)*

comment = "#" (![\n\r] .)*

EOF = !.
