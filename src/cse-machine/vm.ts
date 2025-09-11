import * as es from "estree";
import { ControlItem } from "./control";
import { Context } from "./context";
import { Closure } from "./closure";
import { Environment } from "./environment";
import { Value } from "./stash";
import { getVariable } from "./utils";

export default class VMEngine {
  prepare(command: ControlItem, context: Context) {}

  tryExecuteSync() {}

  updateHotness() {}
}

/**
 * Walk a closure's AST to determine
 * - its parameter names (args)
 * - the set of free identifiers used in the body (captures), and fetch their
 *   current values by walking the closure's CSE environment chain.
 *
 * Notes (intentionally simple):
 * - Skips nested function bodies to avoid over-capturing from inner scopes
 * - Treats declarations (var/let/const and function declarations) as local
 * - Does not traverse into non-computed property keys
 */
export function collectArgsAndCaptures(
  closure: Closure,
  context: Context
): {
  args: string[];
  captures: Record<string, Value>;
} {
  const func = closure.node;

  // 1) Parameters
  const args: string[] = [];
  const paramNames = new Set<string>();
  for (const p of func.params) {
    if ((p as es.Identifier).type === "Identifier") {
      const name = (p as es.Identifier).name;
      args.push(name);
      paramNames.add(name);
    }
    // Other parameter patterns are ignored in this simple helper
  }

  // 2) Collect locally declared names (function-scope) to exclude from captures
  const localDecls = new Set<string>();

  const recordLocalDecls = (node: es.Node): void => {
    if (node.type === "VariableDeclaration") {
      for (const d of node.declarations) {
        const id = d.id as es.Identifier;
        if (id && id.type === "Identifier") {
          localDecls.add(id.name);
        }
      }
    } else if (node.type === "FunctionDeclaration" && node.id) {
      localDecls.add(node.id.name);
    }
  };

  const usedNames = new Set<string>();

  // 3) Traverse function body to find identifier usages
  const visit = (node: any): void => {
    if (!node || typeof node !== "object") return;

    // Do not descend into nested functions
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "ArrowFunctionExpression"
    ) {
      // still record the declaration name if any, but skip body
      if (node.type === "FunctionDeclaration" && node.id) {
        localDecls.add(node.id.name);
      }
      return;
    }

    // Record declarations
    if (
      node.type === "VariableDeclaration" ||
      node.type === "FunctionDeclaration"
    ) {
      recordLocalDecls(node);
    }

    // Identifier usage (best-effort filtering of non-uses)
    if (node.type === "Identifier") {
      const name = (node as es.Identifier).name;
      if (!paramNames.has(name) && !localDecls.has(name)) {
        usedNames.add(name);
      }
      return;
    }

    // MemberExpression: traverse object; traverse property only if computed
    if (node.type === "MemberExpression") {
      visit(node.object);
      if (node.computed) visit(node.property);
      return;
    }

    // Property in object literal: traverse value; traverse key only if computed
    if (node.type === "Property") {
      if (node.computed) visit(node.key);
      visit(node.value);
      return;
    }

    // VariableDeclarator: don't treat id as usage; traverse init
    if (node.type === "VariableDeclarator") {
      if (node.init) visit(node.init);
      return;
    }

    // General fallback: recursively visit all object properties
    for (const key of Object.keys(node)) {
      if (key === "parent") continue;
      const child = (node as any)[key];
      if (Array.isArray(child)) {
        for (const c of child) visit(c);
      } else {
        visit(child);
      }
    }
  };

  // Start traversal from function body
  visit(func.body);

  // 4) Fetch capture values using getVariable from utils
  const captures: Record<string, Value> = {};

  // Temporarily set the context environment to the closure's environment
  // to resolve captures from the closure's lexical scope
  const originalEnv = context.runtime.environments[0];
  context.runtime.environments[0] = closure.environment;

  for (const name of usedNames) {
    try {
      const value = getVariable(context, name, {
        type: "Identifier",
        name,
      } as es.Identifier);
      if (value !== undefined) {
        captures[name] = value;
      }
    } catch (e) {
      // Variable not found, skip it
    }
  }

  // Restore original environment
  context.runtime.environments[0] = originalEnv;

  return { args, captures };
}
