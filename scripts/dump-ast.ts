#!/usr/bin/env tsx
/**
 * Dump before/after AST as a DOT graph for visual diffing.
 *
 * Usage:
 *   tsx scripts/dump-ast.ts <file.py>              # DOT to stdout
 *   tsx scripts/dump-ast.ts --inline "x = 1 + 2"   # inline source
 *   tsx scripts/dump-ast.ts <file.py> -o out.dot    # write to file
 *
 * Output is a single DOT digraph with two subgraphs: BEFORE and AFTER
 * specialization. Open the .dot file in a VS Code DOT visualizer.
 */

import fs from "fs";
import { ExprNS, StmtNS } from "../src/ast-types";
import { parse } from "../src/parser/parser-adapter";
import { analyzeWithEnvironments } from "../src/resolver";
import { SVMLCompiler } from "../src/engines/svml/svml-compiler";
import { optimize } from "../src/specialization";

// ── CLI ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let source!: string;
let outFile: string | null = null;
const positional: string[] = [];

for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--inline") {
    source = argv.slice(i + 1).join(" ") + "\n";
    break;
  } else if (argv[i] === "-o" && argv[i + 1]) {
    outFile = argv[++i];
  } else {
    positional.push(argv[i]);
  }
}

if (!source) {
  if (positional[0]) {
    source = fs.readFileSync(positional[0], "utf-8");
    if (!source.endsWith("\n")) source += "\n";
  } else {
    console.error("Usage: tsx scripts/dump-ast.ts <file.py>");
    console.error('       tsx scripts/dump-ast.ts --inline "x = 1 + 2"');
    process.exit(1);
  }
}

// ── DOT graph builder ────────────────────────────────────────────────
class DotGraph {
  private id = 0;
  private readonly prefix: string;
  private readonly lines: string[] = [];

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  node(label: string, color?: string): string {
    const id = `${this.prefix}_${this.id++}`;
    const esc = label.replace(/"/g, '\\"');
    const style = color ? `, style=filled, fillcolor="${color}"` : "";
    this.lines.push(`${id} [label="${esc}"${style}];`);
    return id;
  }

  edge(from: string, to: string, label?: string): void {
    const lbl = label ? ` [label="${label.replace(/"/g, '\\"')}", fontsize=9]` : "";
    this.lines.push(`${from} -> ${to}${lbl};`);
  }

  render(): string {
    return this.lines.join("\n    ");
  }
}

// ── AST -> DOT emitters ─────────────────────────────────────────────
function emitExpr(expr: ExprNS.Expr, g: DotGraph): string {
  if (expr instanceof ExprNS.Literal) {
    return g.node(`${JSON.stringify(expr.value)}`, "#d4edda");
  } else if (expr instanceof ExprNS.BigIntLiteral) {
    return g.node(`${expr.value}`, "#d4edda");
  } else if (expr instanceof ExprNS.Variable) {
    return g.node(expr.name.lexeme, "#fff3cd");
  } else if (expr instanceof ExprNS.Binary) {
    const id = g.node(`${expr.operator.lexeme}`, "#e2e3f1");
    g.edge(id, emitExpr(expr.left, g), "L");
    g.edge(id, emitExpr(expr.right, g), "R");
    return id;
  } else if (expr instanceof ExprNS.Compare) {
    const id = g.node(`${expr.operator.lexeme}`, "#e2e3f1");
    g.edge(id, emitExpr(expr.left, g), "L");
    g.edge(id, emitExpr(expr.right, g), "R");
    return id;
  } else if (expr instanceof ExprNS.BoolOp) {
    const id = g.node(`${expr.operator.lexeme}`, "#e2e3f1");
    g.edge(id, emitExpr(expr.left, g), "L");
    g.edge(id, emitExpr(expr.right, g), "R");
    return id;
  } else if (expr instanceof ExprNS.Unary) {
    const id = g.node(`unary ${expr.operator.lexeme}`, "#e2e3f1");
    g.edge(id, emitExpr(expr.right, g));
    return id;
  } else if (expr instanceof ExprNS.Grouping) {
    return emitExpr(expr.expression, g);
  } else if (expr instanceof ExprNS.Ternary) {
    const id = g.node("?:", "#f0e6ff");
    g.edge(id, emitExpr(expr.predicate, g), "cond");
    g.edge(id, emitExpr(expr.consequent, g), "then");
    g.edge(id, emitExpr(expr.alternative, g), "else");
    return id;
  } else if (expr instanceof ExprNS.Call) {
    const id = g.node("call", "#fce4ec");
    g.edge(id, emitExpr(expr.callee, g), "fn");
    expr.args.forEach((a, i) => g.edge(id, emitExpr(a, g), `${i}`));
    return id;
  } else if (expr instanceof ExprNS.Lambda) {
    const params = expr.parameters.map(p => p.lexeme).join(", ");
    const id = g.node(`\u03bb(${params})`, "#e0f7fa");
    g.edge(id, emitExpr(expr.body, g));
    return id;
  } else if (expr instanceof ExprNS.MultiLambda) {
    const params = expr.parameters.map(p => p.lexeme).join(", ");
    const id = g.node(`\u03bb(${params})`, "#e0f7fa");
    emitBody(expr.body, g, id);
    return id;
  } else if (expr instanceof ExprNS.List) {
    const id = g.node("list", "#f0f0f0");
    expr.elements.forEach((el, i) => g.edge(id, emitExpr(el, g), `${i}`));
    return id;
  } else if (expr instanceof ExprNS.Subscript) {
    const id = g.node("[]", "#e2e3f1");
    g.edge(id, emitExpr(expr.value, g), "obj");
    g.edge(id, emitExpr(expr.index, g), "idx");
    return id;
  } else if (expr instanceof ExprNS.Starred) {
    const id = g.node("*", "#e2e3f1");
    g.edge(id, emitExpr(expr.value, g));
    return id;
  } else if (expr instanceof ExprNS.None) {
    return g.node("None", "#d4edda");
  } else if (expr instanceof ExprNS.Complex) {
    return g.node(`${expr.value}`, "#d4edda");
  } else {
    return g.node(`<${(expr as any).kind}>`, "#ffcccc");
  }
}

function emitBody(stmts: StmtNS.Stmt[], g: DotGraph, parent: string): void {
  for (const stmt of stmts) {
    g.edge(parent, emitStmt(stmt, g));
  }
}

function emitStmt(stmt: StmtNS.Stmt, g: DotGraph): string {
  if (stmt instanceof StmtNS.SimpleExpr) {
    const id = g.node("expr", "#f5f5f5");
    g.edge(id, emitExpr(stmt.expression, g));
    return id;
  } else if (stmt instanceof StmtNS.Assign) {
    const id = g.node("=", "#dbeafe");
    g.edge(id, emitExpr(stmt.target as ExprNS.Expr, g), "target");
    g.edge(id, emitExpr(stmt.value, g), "value");
    return id;
  } else if (stmt instanceof StmtNS.AnnAssign) {
    const id = g.node(":=", "#dbeafe");
    g.edge(id, emitExpr(stmt.target, g), "target");
    g.edge(id, emitExpr(stmt.value, g), "value");
    return id;
  } else if (stmt instanceof StmtNS.If) {
    const id = g.node("if", "#fff3cd");
    g.edge(id, emitExpr(stmt.condition, g), "cond");
    const bodyId = g.node("body", "#f5f5f5");
    g.edge(id, bodyId, "then");
    emitBody(stmt.body, g, bodyId);
    if (stmt.elseBlock) {
      const elseId = g.node("else", "#f5f5f5");
      g.edge(id, elseId, "else");
      emitBody(stmt.elseBlock, g, elseId);
    }
    return id;
  } else if (stmt instanceof StmtNS.While) {
    const id = g.node("while", "#fff3cd");
    g.edge(id, emitExpr(stmt.condition, g), "cond");
    const bodyId = g.node("body", "#f5f5f5");
    g.edge(id, bodyId);
    emitBody(stmt.body, g, bodyId);
    return id;
  } else if (stmt instanceof StmtNS.For) {
    const id = g.node(`for ${stmt.target.lexeme}`, "#fff3cd");
    g.edge(id, emitExpr(stmt.iter, g), "iter");
    const bodyId = g.node("body", "#f5f5f5");
    g.edge(id, bodyId);
    emitBody(stmt.body, g, bodyId);
    return id;
  } else if (stmt instanceof StmtNS.FunctionDef) {
    const params = stmt.parameters.map(p => p.lexeme).join(", ");
    const id = g.node(`def ${stmt.name.lexeme}(${params})`, "#e0f7fa");
    emitBody(stmt.body, g, id);
    return id;
  } else if (stmt instanceof StmtNS.Return) {
    const id = g.node("return", "#fce4ec");
    if (stmt.value) g.edge(id, emitExpr(stmt.value, g));
    return id;
  } else if (stmt instanceof StmtNS.Pass) {
    return g.node("pass", "#f5f5f5");
  } else if (stmt instanceof StmtNS.Break) {
    return g.node("break", "#fce4ec");
  } else if (stmt instanceof StmtNS.Continue) {
    return g.node("continue", "#fce4ec");
  } else if (stmt instanceof StmtNS.Assert) {
    const id = g.node("assert", "#fce4ec");
    g.edge(id, emitExpr(stmt.value, g));
    return id;
  } else if (stmt instanceof StmtNS.Global) {
    return g.node(`global ${stmt.name.lexeme}`, "#f5f5f5");
  } else if (stmt instanceof StmtNS.NonLocal) {
    return g.node(`nonlocal ${stmt.name.lexeme}`, "#f5f5f5");
  } else if (stmt instanceof StmtNS.FromImport) {
    const names = stmt.names
      .map(n => (n.alias ? `${n.name.lexeme} as ${n.alias.lexeme}` : n.name.lexeme))
      .join(", ");
    return g.node(`from ${stmt.module.lexeme} import ${names}`, "#f5f5f5");
  } else if (stmt instanceof StmtNS.FileInput) {
    const id = g.node("module", "#dbeafe");
    emitBody(stmt.statements, g, id);
    return id;
  } else {
    return g.node(`<${(stmt as any).kind}>`, "#ffcccc");
  }
}

// ── Main ─────────────────────────────────────────────────────────────
const ast = parse(source);

const before = new DotGraph("b");
for (const s of ast.statements) emitStmt(s, before);

// Resolve + optimize
const { errors, environments } = analyzeWithEnvironments(ast, source, 4);
if (errors.length > 0) {
  console.error("Resolver errors:");
  for (const e of errors) console.error(" ", String(e));
  process.exit(1);
}
const compiler = SVMLCompiler.fromProgram(ast, environments);
optimize(ast.statements, compiler.createSlotLookup());

const after = new DotGraph("a");
for (const s of ast.statements) emitStmt(s, after);

// Compose DOT
const dot = `digraph AST {
  rankdir=TB;
  node [shape=box, fontname="Menlo, monospace", fontsize=11];
  edge [arrowsize=0.6];

  subgraph cluster_before {
    label="BEFORE (parse only)";
    style=dashed; color="#888"; fontcolor="#888";
    ${before.render()}
  }

  subgraph cluster_after {
    label="AFTER (specialized)";
    style=dashed; color="#2a7fff"; fontcolor="#2a7fff";
    ${after.render()}
  }
}
`;

if (outFile) {
  fs.writeFileSync(outFile, dot);
  console.error(`Written to ${outFile}`);
} else {
  process.stdout.write(dot);
}
