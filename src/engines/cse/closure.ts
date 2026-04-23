import { ExprNS, StmtNS } from "../../ast-types";
import { ControlItem } from "./control";
import { Environment } from "./environment";
import { StatementSequence } from "./types";
import { isNode } from "./utils";

/**
 * Represents a Python closure, the class is a runtime representation of a function.
 * Bundles the function's code (AST node) with environment in which its defined.
 * When Closure is called, a new environment will be created whose parent is the 'Environment' captured
 */
export class Closure {
  /** Unique ID defined for closure */
  public readonly id: string;
  /** AST node for function, either a 'def' or 'lambda' */
  public node: StmtNS.FunctionDef | ExprNS.Lambda;
  /** Environment captures at time of function's definition, key for lexical scoping */
  public environment: Environment;
  public readonly predefined: boolean;
  public originalNode?: StmtNS.FunctionDef | ExprNS.Lambda;
  /** Stores local variables for scope check */
  public localVariables: Set<string>;

  /** Name of the constant declaration that the closure is assigned to */
  public declaredName?: string;

  constructor(
    node: StmtNS.FunctionDef | ExprNS.Lambda,
    environment: Environment,
    id: string,
    predefined: boolean = false,
    localVariables: Set<string> = new Set(),
  ) {
    this.id = id;
    this.node = node;
    this.environment = environment;
    this.predefined = predefined;
    this.originalNode = node;
    this.localVariables = localVariables;
  }

  static makeFromFunctionDef(
    node: StmtNS.FunctionDef,
    environment: Environment,
    id: string,
    localVariables: Set<string>,
  ): Closure {
    return new Closure(node, environment, id, false, localVariables);
  }

  static makeFromLambda(
    node: ExprNS.Lambda,
    environment: Environment,
    id: string,
    localVariables: Set<string>,
  ): Closure {
    return new Closure(node, environment, id, false, localVariables);
  }
}

export const isStatementSequence = (node: ControlItem): node is StatementSequence => {
  return isNode(node) && node.kind == "StatementSequence";
};
