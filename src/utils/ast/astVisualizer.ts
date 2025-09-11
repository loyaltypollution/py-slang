import { Program, Node, Statement, Expression, BaseNode } from "estree";
import * as fs from "fs";
import * as path from "path";

/**
 * AST Visualizer that converts EsTree AST nodes to DOT format
 * for visualization using Graphviz or similar tools
 */
export default class ASTVisualizer {
  private nodeCounter = 0;
  private nodeMap = new Map<Node, string>();

  /**
   * Convert an EsTree AST to DOT format
   */
  public astToDot(ast: Program, title: string = "AST Visualization"): string {
    this.nodeCounter = 0;
    this.nodeMap.clear();

    const nodes: string[] = [];
    const edges: string[] = [];

    // Process the AST
    this.processNode(ast, nodes, edges);

    return `digraph AST {
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
   * Process a node and its children recursively
   */
  private processNode(node: Node, nodes: string[], edges: string[]): string {
    // if (!node) {
    //   throw new Error('Cannot process null or undefined node');
    // }

    const nodeId = this.getNodeId(node);

    // Create node label
    const label = this.createNodeLabel(node);
    const color = this.getNodeColor(node);

    nodes.push(`  ${nodeId} [label="${label}", fillcolor="${color}"];`);

    // Process children
    const children = this.getChildren(node);
    for (const [childKey, child] of children) {
      if (child) {
        const childId = this.processNode(child, nodes, edges);
        edges.push(`  ${nodeId} -> ${childId} [label="${childKey}"];`);
      }
    }

    // Handle arrays of children
    const arrayChildren = this.getArrayChildren(node);
    for (const [childKey, childArray] of arrayChildren) {
      if (Array.isArray(childArray)) {
        childArray.forEach((child, index) => {
          if (child) {
            const childId = this.processNode(child, nodes, edges);
            edges.push(
              `  ${nodeId} -> ${childId} [label="${childKey}[${index}]"];`
            );
          }
        });
      }
    }

    return nodeId;
  }

  /**
   * Get a unique ID for a node
   */
  private getNodeId(node: Node): string {
    if (this.nodeMap.has(node)) {
      return this.nodeMap.get(node)!;
    }
    const id = `node_${this.nodeCounter++}`;
    this.nodeMap.set(node, id);
    return id;
  }

  /**
   * Create a label for a node
   */
  private createNodeLabel(node: Node): string {
    const type = node.type || "Unknown";
    let label = type;

    // Add specific information based on node type
    switch (type) {
      case "Identifier":
        const name = (node as any).name;
        if (name !== undefined && name !== null) {
          label += `\\n${name}`;
        }
        break;
      case "Literal":
        const value = (node as any).value;
        if (value !== undefined && value !== null) {
          if (typeof value === "string") {
            label += `\\n"${value}"`;
          } else {
            label += `\\n${value}`;
          }
        }
        break;
      case "FunctionDeclaration":
        const funcName = (node as any).id?.name || "anonymous";
        label += `\\n${funcName}`;
        break;
      case "VariableDeclaration":
        const kind = (node as any).kind;
        if (kind) {
          label += `\\n${kind}`;
        }
        break;
      case "BinaryExpression":
        const binOp = (node as any).operator;
        if (binOp) {
          label += `\\n${binOp}`;
        }
        break;
      case "UnaryExpression":
        const unaryOp = (node as any).operator;
        if (unaryOp) {
          label += `\\n${unaryOp}`;
        }
        break;
      case "CallExpression":
        const callee = (node as any).callee;
        if (callee && callee.name) {
          label += `\\n${callee.name}()`;
        }
        break;
      case "AssignmentExpression":
        const assignOp = (node as any).operator;
        if (assignOp) {
          label += `\\n${assignOp}`;
        }
        break;
      case "BlockStatement":
        const bodyLength = (node as any).body?.length || 0;
        label += `\\n${bodyLength} statements`;
        break;
    }

    // // Add location info if available
    // if (node.loc && node.loc.start) {
    //   label += `\\n(${node.loc.start.line}:${node.loc.start.column})`;
    // }

    // Ensure label is a string and escape quotes
    if (typeof label === "string") {
      return label.replace(/"/g, '\\"');
    } else {
      return String(label).replace(/"/g, '\\"');
    }
  }

  /**
   * Get color for a node based on its type
   */
  private getNodeColor(node: Node): string {
    const type = node.type;

    switch (type) {
      case "Program":
        return "#E8F4FD"; // Light blue
      case "FunctionDeclaration":
        return "#E8F5E8"; // Light green
      case "VariableDeclaration":
        return "#FFF2CC"; // Light yellow
      case "ExpressionStatement":
        return "#F0F0F0"; // Light gray
      case "BinaryExpression":
      case "UnaryExpression":
        return "#FFE6E6"; // Light red
      case "CallExpression":
        return "#E6E6FF"; // Light purple
      case "Identifier":
        return "#F0F8FF"; // Alice blue
      case "Literal":
        return "#F5F5DC"; // Beige
      case "BlockStatement":
        return "#F8F8FF"; // Ghost white
      case "IfStatement":
        return "#FFE4E1"; // Misty rose
      case "ReturnStatement":
        return "#E0FFFF"; // Light cyan
      default:
        return "#FFFFFF"; // White
    }
  }

  /**
   * Get direct children of a node
   */
  private getChildren(node: Node): Array<[string, Node | null]> {
    const children: Array<[string, Node | null]> = [];

    switch (node.type) {
      case "Program":
        // Program has body array, handled separately
        break;
      case "FunctionDeclaration":
        children.push(["id", (node as any).id]);
        children.push(["body", (node as any).body]);
        break;
      case "VariableDeclaration":
        // VariableDeclaration has declarations array, handled separately
        break;
      case "VariableDeclarator":
        children.push(["id", (node as any).id]);
        children.push(["init", (node as any).init]);
        break;
      case "ExpressionStatement":
        children.push(["expression", (node as any).expression]);
        break;
      case "BinaryExpression":
        children.push(["left", (node as any).left]);
        children.push(["right", (node as any).right]);
        break;
      case "UnaryExpression":
        children.push(["argument", (node as any).argument]);
        break;
      case "CallExpression":
        children.push(["callee", (node as any).callee]);
        // Arguments array handled separately
        break;
      case "IfStatement":
        children.push(["test", (node as any).test]);
        children.push(["consequent", (node as any).consequent]);
        children.push(["alternate", (node as any).alternate]);
        break;
      case "ReturnStatement":
        children.push(["argument", (node as any).argument]);
        break;
      case "BlockStatement":
        // Body array handled separately
        break;
    }

    return children.filter(([_, child]) => child !== null);
  }

  /**
   * Get array children of a node
   */
  private getArrayChildren(node: Node): Array<[string, Node[] | null]> {
    const arrayChildren: Array<[string, Node[] | null]> = [];

    switch (node.type) {
      case "Program":
        arrayChildren.push(["body", (node as any).body]);
        break;
      case "VariableDeclaration":
        arrayChildren.push(["declarations", (node as any).declarations]);
        break;
      case "FunctionDeclaration":
        arrayChildren.push(["params", (node as any).params]);
        break;
      case "CallExpression":
        arrayChildren.push(["arguments", (node as any).arguments]);
        break;
      case "BlockStatement":
        arrayChildren.push(["body", (node as any).body]);
        break;
    }

    return arrayChildren.filter(([_, children]) => children !== null);
  }

  /**
   * Save AST visualization to a DOT file
   */
  public saveToFile(ast: Program, filename: string, title?: string): void {
    title = title || `AST: ${path.basename(filename, ".dot")}`;
    const dotContent = this.astToDot(ast, title);
    // Ensure output directory exists
    const outputDir = path.dirname(filename);
    if (outputDir && !fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    fs.writeFileSync(filename, dotContent);
    console.log(`AST visualization saved to: ${filename}`);

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
    console.log(`DOT content for ${filename}:`);
    console.log(dotContent);
  }
}
