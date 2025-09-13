import { StmtNS, ExprNS } from "../ast-types";
import { Token } from "../tokenizer";
import * as fs from "fs";
import * as path from "path";

/**
 * Python AST Visualizer that converts StmtNS.Stmt and ExprNS.Expr nodes to DOT format
 * for visualization using Graphviz or similar tools
 */
export default class PyASTVisualizer {
  private nodeCounter = 0;
  private nodeMap = new Map<StmtNS.Stmt | ExprNS.Expr | Token, string>();

  /**
   * Convert a Python AST to DOT format
   */
  public astToDot(ast: StmtNS.FileInput, title: string = "Python AST Visualization"): string {
    this.nodeCounter = 0;
    this.nodeMap.clear();

    const nodes: string[] = [];
    const edges: string[] = [];

    // Process the AST
    this.processStatement(ast, nodes, edges);

    return `digraph PyAST {
  // Graph properties
  rankdir=TB;
  node [shape=box, style=filled, fontname="Arial", fontsize=10];
  edge [fontname="Arial", fontsize=8];
  
  // Title
  label="${title}";
  labelloc="t";
  fontsize=16;
  
  // Nodes
${nodes.join("\n")}
  
  // Edges
${edges.join("\n")}
}`;
  }

  /**
   * Process a statement and its children recursively
   */
  private processStatement(stmt: StmtNS.Stmt, nodes: string[], edges: string[]): string {
    const nodeId = this.getNodeId(stmt);

    // Create node label
    const label = this.createStatementLabel(stmt);
    const color = this.getStatementColor(stmt);

    nodes.push(`  ${nodeId} [label="${label}", fillcolor="${color}"];`);

    // Process children based on statement type
    if (stmt instanceof StmtNS.FileInput) {
      // Process all statements in the file
      stmt.statements.forEach((childStmt, index) => {
        const childId = this.processStatement(childStmt, nodes, edges);
        edges.push(`  ${nodeId} -> ${childId} [label="stmt[${index}]"];`);
      });

      // Process variable declarations if any
      if (stmt.varDecls && stmt.varDecls.length > 0) {
        stmt.varDecls.forEach((varDecl, index) => {
          const declId = this.processToken(varDecl, nodes, edges, "VarDecl");
          edges.push(`  ${nodeId} -> ${declId} [label="varDecl[${index}]"];`);
        });
      }
    } else if (stmt instanceof StmtNS.FunctionDef) {
      // Process function name
      const nameId = this.processToken(stmt.name, nodes, edges, "FunctionName");
      edges.push(`  ${nodeId} -> ${nameId} [label="name"];`);

      // Process parameters
      stmt.parameters.forEach((param, index) => {
        const paramId = this.processToken(param, nodes, edges, "Parameter");
        edges.push(`  ${nodeId} -> ${paramId} [label="param[${index}]"];`);
      });

      // Process function body
      stmt.body.forEach((bodyStmt, index) => {
        const bodyId = this.processStatement(bodyStmt, nodes, edges);
        edges.push(`  ${nodeId} -> ${bodyId} [label="body[${index}]"];`);
      });

      // Process variable declarations if any
      if (stmt.varDecls && stmt.varDecls.length > 0) {
        stmt.varDecls.forEach((varDecl, index) => {
          const declId = this.processToken(varDecl, nodes, edges, "VarDecl");
          edges.push(`  ${nodeId} -> ${declId} [label="varDecl[${index}]"];`);
        });
      }
    } else if (stmt instanceof StmtNS.Assign) {
      // Process assignment target
      const nameId = this.processToken(stmt.name, nodes, edges, "AssignTarget");
      edges.push(`  ${nodeId} -> ${nameId} [label="target"];`);

      // Process assignment value
      const valueId = this.processExpression(stmt.value, nodes, edges);
      edges.push(`  ${nodeId} -> ${valueId} [label="value"];`);
    } else if (stmt instanceof StmtNS.AnnAssign) {
      // Process assignment target
      const nameId = this.processToken(stmt.name, nodes, edges, "AssignTarget");
      edges.push(`  ${nodeId} -> ${nameId} [label="target"];`);

      // Process assignment value
      const valueId = this.processExpression(stmt.value, nodes, edges);
      edges.push(`  ${nodeId} -> ${valueId} [label="value"];`);

      // Process annotation
      const annId = this.processExpression(stmt.ann, nodes, edges);
      edges.push(`  ${nodeId} -> ${annId} [label="annotation"];`);
    } else if (stmt instanceof StmtNS.If) {
      // Process condition
      const condId = this.processExpression(stmt.condition, nodes, edges);
      edges.push(`  ${nodeId} -> ${condId} [label="condition"];`);

      // Process if body
      stmt.body.forEach((bodyStmt, index) => {
        const bodyId = this.processStatement(bodyStmt, nodes, edges);
        edges.push(`  ${nodeId} -> ${bodyId} [label="then[${index}]"];`);
      });

      // Process else body if present
      if (stmt.elseBlock) {
        stmt.elseBlock.forEach((elseStmt, index) => {
          const elseId = this.processStatement(elseStmt, nodes, edges);
          edges.push(`  ${nodeId} -> ${elseId} [label="else[${index}]"];`);
        });
      }
    } else if (stmt instanceof StmtNS.While) {
      // Process condition
      const condId = this.processExpression(stmt.condition, nodes, edges);
      edges.push(`  ${nodeId} -> ${condId} [label="condition"];`);

      // Process while body
      stmt.body.forEach((bodyStmt, index) => {
        const bodyId = this.processStatement(bodyStmt, nodes, edges);
        edges.push(`  ${nodeId} -> ${bodyId} [label="body[${index}]"];`);
      });
    } else if (stmt instanceof StmtNS.For) {
      // Process target
      const targetId = this.processToken(stmt.target, nodes, edges, "ForTarget");
      edges.push(`  ${nodeId} -> ${targetId} [label="target"];`);

      // Process iterable
      const iterId = this.processExpression(stmt.iter, nodes, edges);
      edges.push(`  ${nodeId} -> ${iterId} [label="iter"];`);

      // Process for body
      stmt.body.forEach((bodyStmt, index) => {
        const bodyId = this.processStatement(bodyStmt, nodes, edges);
        edges.push(`  ${nodeId} -> ${bodyId} [label="body[${index}]"];`);
      });
    } else if (stmt instanceof StmtNS.Return) {
      // Process return value if present
      if (stmt.value) {
        const valueId = this.processExpression(stmt.value, nodes, edges);
        edges.push(`  ${nodeId} -> ${valueId} [label="value"];`);
      }
    } else if (stmt instanceof StmtNS.SimpleExpr) {
      // Process expression
      const exprId = this.processExpression(stmt.expression, nodes, edges);
      edges.push(`  ${nodeId} -> ${exprId} [label="expression"];`);
    } else if (stmt instanceof StmtNS.Assert) {
      // Process assertion value
      const valueId = this.processExpression(stmt.value, nodes, edges);
      edges.push(`  ${nodeId} -> ${valueId} [label="test"];`);
    } else if (stmt instanceof StmtNS.Global) {
      // Process global name
      const nameId = this.processToken(stmt.name, nodes, edges, "GlobalName");
      edges.push(`  ${nodeId} -> ${nameId} [label="name"];`);
    } else if (stmt instanceof StmtNS.NonLocal) {
      // Process nonlocal name
      const nameId = this.processToken(stmt.name, nodes, edges, "NonLocalName");
      edges.push(`  ${nodeId} -> ${nameId} [label="name"];`);
    } else if (stmt instanceof StmtNS.FromImport) {
      // Process module
      const moduleId = this.processToken(stmt.module, nodes, edges, "ModuleName");
      edges.push(`  ${nodeId} -> ${moduleId} [label="module"];`);

      // Process imported names
      stmt.names.forEach((name, index) => {
        const nameId = this.processToken(name, nodes, edges, "ImportName");
        edges.push(`  ${nodeId} -> ${nameId} [label="name[${index}]"];`);
      });
    }
    // StmtNS.Pass, StmtNS.Break, StmtNS.Continue, StmtNS.Indent, StmtNS.Dedent have no children

    return nodeId;
  }

  /**
   * Process an expression and its children recursively
   */
  private processExpression(expr: ExprNS.Expr, nodes: string[], edges: string[]): string {
    const nodeId = this.getNodeId(expr);

    // Create node label
    const label = this.createExpressionLabel(expr);
    const color = this.getExpressionColor(expr);

    nodes.push(`  ${nodeId} [label="${label}", fillcolor="${color}"];`);

    // Process children based on expression type
    if (expr instanceof ExprNS.Binary) {
      // Process left operand
      const leftId = this.processExpression(expr.left, nodes, edges);
      edges.push(`  ${nodeId} -> ${leftId} [label="left"];`);

      // Process operator
      const opId = this.processToken(expr.operator, nodes, edges, "BinaryOp");
      edges.push(`  ${nodeId} -> ${opId} [label="op"];`);

      // Process right operand
      const rightId = this.processExpression(expr.right, nodes, edges);
      edges.push(`  ${nodeId} -> ${rightId} [label="right"];`);
    } else if (expr instanceof ExprNS.Compare) {
      // Process left operand
      const leftId = this.processExpression(expr.left, nodes, edges);
      edges.push(`  ${nodeId} -> ${leftId} [label="left"];`);

      // Process operator
      const opId = this.processToken(expr.operator, nodes, edges, "CompareOp");
      edges.push(`  ${nodeId} -> ${opId} [label="op"];`);

      // Process right operand
      const rightId = this.processExpression(expr.right, nodes, edges);
      edges.push(`  ${nodeId} -> ${rightId} [label="right"];`);
    } else if (expr instanceof ExprNS.BoolOp) {
      // Process left operand
      const leftId = this.processExpression(expr.left, nodes, edges);
      edges.push(`  ${nodeId} -> ${leftId} [label="left"];`);

      // Process operator
      const opId = this.processToken(expr.operator, nodes, edges, "BoolOp");
      edges.push(`  ${nodeId} -> ${opId} [label="op"];`);

      // Process right operand
      const rightId = this.processExpression(expr.right, nodes, edges);
      edges.push(`  ${nodeId} -> ${rightId} [label="right"];`);
    } else if (expr instanceof ExprNS.Unary) {
      // Process operator
      const opId = this.processToken(expr.operator, nodes, edges, "UnaryOp");
      edges.push(`  ${nodeId} -> ${opId} [label="op"];`);

      // Process operand
      const operandId = this.processExpression(expr.right, nodes, edges);
      edges.push(`  ${nodeId} -> ${operandId} [label="operand"];`);
    } else if (expr instanceof ExprNS.Call) {
      // Process callee
      const calleeId = this.processExpression(expr.callee, nodes, edges);
      edges.push(`  ${nodeId} -> ${calleeId} [label="callee"];`);

      // Process arguments
      expr.args.forEach((arg, index) => {
        const argId = this.processExpression(arg, nodes, edges);
        edges.push(`  ${nodeId} -> ${argId} [label="arg[${index}]"];`);
      });
    } else if (expr instanceof ExprNS.Ternary) {
      // Process predicate
      const predId = this.processExpression(expr.predicate, nodes, edges);
      edges.push(`  ${nodeId} -> ${predId} [label="test"];`);

      // Process consequent
      const consId = this.processExpression(expr.consequent, nodes, edges);
      edges.push(`  ${nodeId} -> ${consId} [label="then"];`);

      // Process alternative
      const altId = this.processExpression(expr.alternative, nodes, edges);
      edges.push(`  ${nodeId} -> ${altId} [label="else"];`);
    } else if (expr instanceof ExprNS.Lambda) {
      // Process parameters
      expr.parameters.forEach((param, index) => {
        const paramId = this.processToken(param, nodes, edges, "LambdaParam");
        edges.push(`  ${nodeId} -> ${paramId} [label="param[${index}]"];`);
      });

      // Process body
      const bodyId = this.processExpression(expr.body, nodes, edges);
      edges.push(`  ${nodeId} -> ${bodyId} [label="body"];`);
    } else if (expr instanceof ExprNS.MultiLambda) {
      // Process parameters
      expr.parameters.forEach((param, index) => {
        const paramId = this.processToken(param, nodes, edges, "LambdaParam");
        edges.push(`  ${nodeId} -> ${paramId} [label="param[${index}]"];`);
      });

      // Process body statements
      expr.body.forEach((stmt, index) => {
        const stmtId = this.processStatement(stmt, nodes, edges);
        edges.push(`  ${nodeId} -> ${stmtId} [label="body[${index}]"];`);
      });

      // Process variable declarations if any
      if (expr.varDecls && expr.varDecls.length > 0) {
        expr.varDecls.forEach((varDecl, index) => {
          const declId = this.processToken(varDecl, nodes, edges, "VarDecl");
          edges.push(`  ${nodeId} -> ${declId} [label="varDecl[${index}]"];`);
        });
      }
    } else if (expr instanceof ExprNS.Variable) {
      // Process variable name
      const nameId = this.processToken(expr.name, nodes, edges, "VarName");
      edges.push(`  ${nodeId} -> ${nameId} [label="name"];`);
    } else if (expr instanceof ExprNS.Grouping) {
      // Process grouped expression
      const innerId = this.processExpression(expr.expression, nodes, edges);
      edges.push(`  ${nodeId} -> ${innerId} [label="expression"];`);
    }
    // ExprNS.Literal, ExprNS.BigIntLiteral, ExprNS.Complex, ExprNS.None have no children

    return nodeId;
  }

  /**
   * Process a token and create a node for it
   */
  private processToken(token: Token, nodes: string[], edges: string[], type: string): string {
    const nodeId = this.getNodeId(token);

    const label = this.createTokenLabel(token, type);
    const color = this.getTokenColor(type);

    nodes.push(`  ${nodeId} [label="${label}", fillcolor="${color}"];`);

    return nodeId;
  }

  /**
   * Get a unique ID for a node
   */
  private getNodeId(node: StmtNS.Stmt | ExprNS.Expr | Token): string {
    if (this.nodeMap.has(node)) {
      return this.nodeMap.get(node)!;
    }
    const id = `node_${this.nodeCounter++}`;
    this.nodeMap.set(node, id);
    return id;
  }

  /**
   * Create a label for a statement node
   */
  private createStatementLabel(stmt: StmtNS.Stmt): string {
    const type = stmt.constructor.name;
    let label = type;

    // Add specific information based on statement type
    if (stmt instanceof StmtNS.FileInput) {
      label += `\\n${stmt.statements.length} statements`;
      if (stmt.varDecls && stmt.varDecls.length > 0) {
        label += `\\n${stmt.varDecls.length} var decls`;
      }
    } else if (stmt instanceof StmtNS.FunctionDef) {
      label += `\\n${stmt.name.lexeme}`;
      label += `\\n${stmt.parameters.length} params`;
    } else if (stmt instanceof StmtNS.Assign) {
      label += `\\n${stmt.name.lexeme} =`;
    } else if (stmt instanceof StmtNS.AnnAssign) {
      label += `\\n${stmt.name.lexeme}: ... =`;
    }

    return this.escapeLabel(label);
  }

  /**
   * Create a label for an expression node
   */
  private createExpressionLabel(expr: ExprNS.Expr): string {
    const type = expr.constructor.name;
    let label = type;

    // Add specific information based on expression type
    if (expr instanceof ExprNS.Literal) {
      if (typeof expr.value === "string") {
        label += `\\n"${expr.value}"`;
      } else {
        label += `\\n${expr.value}`;
      }
    } else if (expr instanceof ExprNS.BigIntLiteral) {
      label += `\\n${expr.value}n`;
    } else if (expr instanceof ExprNS.Complex) {
      label += `\\n${expr.value.real}+${expr.value.imag}j`;
    } else if (expr instanceof ExprNS.Variable) {
      label += `\\n${expr.name.lexeme}`;
    } else if (expr instanceof ExprNS.Call) {
      label += `\\n${expr.args.length} args`;
    } else if (expr instanceof ExprNS.Lambda) {
      label += `\\n${expr.parameters.length} params`;
    } else if (expr instanceof ExprNS.MultiLambda) {
      label += `\\n${expr.parameters.length} params`;
      label += `\\n${expr.body.length} stmts`;
    }

    return this.escapeLabel(label);
  }

  /**
   * Create a label for a token node
   */
  private createTokenLabel(token: Token, type: string): string {
    let label = type;
    label += `\\n${token.lexeme}`;
    return this.escapeLabel(label);
  }

  /**
   * Escape quotes in labels
   */
  private escapeLabel(label: string): string {
    if (typeof label === "string") {
      return label.replace(/"/g, '\\"');
    } else {
      return String(label).replace(/"/g, '\\"');
    }
  }

  /**
   * Get color for a statement node based on its type
   */
  private getStatementColor(stmt: StmtNS.Stmt): string {
    if (stmt instanceof StmtNS.FileInput) {
      return "#E8F4FD"; // Light blue
    } else if (stmt instanceof StmtNS.FunctionDef) {
      return "#E8F5E8"; // Light green
    } else if (stmt instanceof StmtNS.Assign || stmt instanceof StmtNS.AnnAssign) {
      return "#FFF2CC"; // Light yellow
    } else if (stmt instanceof StmtNS.SimpleExpr) {
      return "#F0F0F0"; // Light gray
    } else if (stmt instanceof StmtNS.If) {
      return "#FFE4E1"; // Misty rose
    } else if (stmt instanceof StmtNS.While || stmt instanceof StmtNS.For) {
      return "#E6E6FA"; // Lavender
    } else if (stmt instanceof StmtNS.Return) {
      return "#E0FFFF"; // Light cyan
    } else if (stmt instanceof StmtNS.Pass || stmt instanceof StmtNS.Break || stmt instanceof StmtNS.Continue) {
      return "#F5F5F5"; // White smoke
    } else {
      return "#FFFFFF"; // White
    }
  }

  /**
   * Get color for an expression node based on its type
   */
  private getExpressionColor(expr: ExprNS.Expr): string {
    if (expr instanceof ExprNS.Binary || expr instanceof ExprNS.Compare || expr instanceof ExprNS.BoolOp) {
      return "#FFE6E6"; // Light red
    } else if (expr instanceof ExprNS.Unary) {
      return "#FFEEE6"; // Light orange
    } else if (expr instanceof ExprNS.Call) {
      return "#E6E6FF"; // Light purple
    } else if (expr instanceof ExprNS.Variable) {
      return "#F0F8FF"; // Alice blue
    } else if (expr instanceof ExprNS.Literal || expr instanceof ExprNS.BigIntLiteral || expr instanceof ExprNS.Complex || expr instanceof ExprNS.None) {
      return "#F5F5DC"; // Beige
    } else if (expr instanceof ExprNS.Lambda || expr instanceof ExprNS.MultiLambda) {
      return "#F0FFF0"; // Honeydew
    } else if (expr instanceof ExprNS.Ternary) {
      return "#FFF8DC"; // Cornsilk
    } else {
      return "#FFFFFF"; // White
    }
  }

  /**
   * Get color for a token node based on its type
   */
  private getTokenColor(type: string): string {
    switch (type) {
      case "FunctionName":
        return "#90EE90"; // Light green
      case "Parameter":
      case "LambdaParam":
        return "#ADD8E6"; // Light blue
      case "AssignTarget":
      case "VarName":
        return "#FFB6C1"; // Light pink
      case "BinaryOp":
      case "CompareOp":
      case "BoolOp":
      case "UnaryOp":
        return "#FFA07A"; // Light salmon
      case "ModuleName":
      case "ImportName":
        return "#98FB98"; // Pale green
      case "VarDecl":
        return "#DDA0DD"; // Plum
      default:
        return "#F0F0F0"; // Light gray
    }
  }

  /**
   * Save Python AST visualization to a DOT file
   */
  public saveToFile(ast: StmtNS.FileInput, filename: string, title?: string): void {
    title = title || `Python AST: ${path.basename(filename, ".dot")}`;
    const dotContent = this.astToDot(ast, title);
    
    // Ensure output directory exists
    const outputDir = path.dirname(filename);
    if (outputDir && !fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    fs.writeFileSync(filename, dotContent);
    console.log(`Python AST visualization saved to: ${filename}`);

    // Show file size
    const stats = fs.statSync(filename);
    console.log(`File size: ${stats.size} bytes`);

    // Show preview of the DOT content
    console.log("\nPreview of DOT content:");
    const lines = dotContent.split("\n");
    const previewLines = lines.slice(0, 20);
    console.log(previewLines.join("\n"));
    if (lines.length > 20) {
      console.log("...");
      console.log(`(showing first 20 lines of ${lines.length} total)`);
    }
  }
}
