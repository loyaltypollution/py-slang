import * as es from "estree";
import { UndefinedVariable } from "../errors/errors";

// ============================================================================
// Environment and Symbol Resolution
// ============================================================================

/**
 * Information about a symbol in the environment
 */
export type SymbolInfo = {
  index: number;
  isVar: boolean; // true for 'let', false for 'const' and function declarations
  type?: "primitive" | "internal"; // for built-in functions
};

/**
 * Resolved symbol with environment level information
 */
export type ResolvedSymbol = {
  envLevel: number;
  index: number;
  isVar: boolean;
  type?: "primitive" | "internal";
};

/**
 * Immutable environment frame
 */
export type Environment = {
  locals: ReadonlyMap<string, SymbolInfo>;
  parent?: Environment;
  depth: number;
};

/**
 * Function metadata collected during analysis
 */
export type FunctionInfo = {
  functionIndex: number;
  envSize: number;
  numArgs: number;
  ast: es.BlockStatement | es.Program;
  environment: Environment;
};

/**
 * Analysis result containing all pre-computed information
 */
export type AnalysisResult = {
  mainFunction: FunctionInfo;
  functions: FunctionInfo[];
  resolvedIdentifiers: WeakMap<es.Identifier, ResolvedSymbol>;
};

// ============================================================================
// Environment Operations
// ============================================================================

/**
 * Create an empty environment
 */
export const createEmptyEnvironment = (): Environment => ({
  locals: new Map(),
  depth: 0,
});

/**
 * Create environment with primitives and internals
 */
export const createGlobalEnvironment = (
  primitives: Map<number, any>,
  vmInternalFunctions: string[] = []
): Environment => {
  const locals = new Map<string, SymbolInfo>();

  // Add primitive functions
  for (let [index, [name]] of primitives.entries()) {
    locals.set(name, { index: index, isVar: false, type: "primitive" });
  }

  // Add VM internal functions
  for (let i = 0; i < vmInternalFunctions.length; i++) {
    const name = vmInternalFunctions[i];
    locals.set(name, { index: i, isVar: false, type: "internal" });
  }

  return { locals, depth: 0 };
};

/**
 * Extend environment with new locals
 */
export const extendEnvironment = (
  parent: Environment,
  locals: Map<string, SymbolInfo>
): Environment => ({
  locals,
  parent,
  depth: parent.depth + 1,
});

/**
 * Look up a symbol in the environment chain
 */
export const lookupSymbol = (
  env: Environment,
  name: string
): ResolvedSymbol | null => {
  let currentEnv: Environment | undefined = env;
  let envLevel = 0;

  while (currentEnv) {
    const symbol = currentEnv.locals.get(name);
    if (symbol) {
      return {
        envLevel,
        index: symbol.index,
        isVar: symbol.isVar,
        type: symbol.type,
      };
    }
    currentEnv = currentEnv.parent;
    envLevel++;
  }

  return null;
};

/**
 * Resolve an identifier node, throwing UndefinedVariable if not found
 */
export const resolveIdentifier = (
  env: Environment,
  node: es.Identifier
): ResolvedSymbol => {
  const resolved = lookupSymbol(env, node.name);
  if (!resolved) {
    throw new UndefinedVariable(node.name, node);
  }
  return resolved;
};

// ============================================================================
// Variable Extraction and Renaming
// ============================================================================

/**
 * Extract all declared names from a block/program, with optional renaming
 */
export const extractDeclaredNames = (
  node: es.BlockStatement | es.Program,
  rename: boolean = true
): Map<string, SymbolInfo> => {
  const names = new Map<string, SymbolInfo>();
  const namesToRename = new Map<string, string>();

  // First pass: collect all declarations
  for (const stmt of node.body) {
    if (stmt.type === "VariableDeclaration") {
      let name = (stmt.declarations[0].id as es.Identifier).name;
      
      if (rename) {
        const loc = stmt.loc?.start ?? { line: 0, column: 0 };
        const oldName = name;
        // Generate unique name
        do {
          name = `${name}-${loc.line}-${loc.column}`;
        } while (names.has(name));
        namesToRename.set(oldName, name);
      }

      const isVar = stmt.kind === "let";
      const index = names.size;
      names.set(name, { index, isVar });
      
    } else if (stmt.type === "FunctionDeclaration") {
      if (!stmt.id) {
        throw new Error("FunctionDeclaration without identifier");
      }
      
      let name = stmt.id.name;
      
      if (rename) {
        const loc = stmt.loc?.start ?? { line: 0, column: 0 };
        const oldName = name;
        do {
          name = `${name}-${loc.line}-${loc.column}`;
        } while (names.has(name));
        namesToRename.set(oldName, name);
      }

      const index = names.size;
      names.set(name, { index, isVar: false });
    }
  }

  // Second pass: rename references if needed
  if (rename && namesToRename.size > 0) {
    renameReferences(node, namesToRename);
  }

  return names;
};

/**
 * Rename variable references in AST
 */
const renameReferences = (
  node: es.BlockStatement | es.Program,
  renamings: Map<string, string>
): void => {
  // This is a simplified version - in practice you'd use your walker
  // For now, we'll implement a basic recursive renamer
  
  const renameInNode = (n: any, shadowedNames: Set<string>) => {
    if (!n || typeof n !== 'object') return;

    if (n.type === 'Identifier' && renamings.has(n.name) && !shadowedNames.has(n.name)) {
      n.name = renamings.get(n.name);
      return;
    }

    // Handle scoping constructs that shadow names
    if (n.type === 'BlockStatement') {
      const localShadows = new Set(shadowedNames);
      // Add locally declared names to shadows
      for (const stmt of n.body) {
        if (stmt.type === 'VariableDeclaration') {
          localShadows.add((stmt.declarations[0].id as es.Identifier).name);
        } else if (stmt.type === 'FunctionDeclaration' && stmt.id) {
          localShadows.add(stmt.id.name);
        }
      }
      
      for (const stmt of n.body) {
        renameInNode(stmt, localShadows);
      }
      return;
    }

    if (n.type === 'Function') {
      const localShadows = new Set(shadowedNames);
      // Add parameters to shadows
      for (const param of n.params || []) {
        if (param.type === 'Identifier') {
          localShadows.add(param.name);
        }
      }
      
      renameInNode(n.body, localShadows);
      return;
    }

    // Recursively process all properties
    for (const key in n) {
      if (n.hasOwnProperty(key) && key !== 'parent') {
        const value = n[key];
        if (Array.isArray(value)) {
          for (const item of value) {
            renameInNode(item, shadowedNames);
          }
        } else {
          renameInNode(value, shadowedNames);
        }
      }
    }
  };

  renameInNode(node, new Set());
};

// ============================================================================
// Analysis Pass
// ============================================================================

/**
 * Perform complete analysis pass on a program
 */
export const analyzeProgram = (
  program: es.Program,
  primitives: Map<number, any>,
  vmInternalFunctions: string[] = []
): AnalysisResult => {
  const resolvedIdentifiers = new WeakMap<es.Identifier, ResolvedSymbol>();
  const functions: FunctionInfo[] = [];
  let functionCounter = 0;

  // Create global environment
  const globalEnv = createGlobalEnvironment(primitives, vmInternalFunctions);

  // Extract main program locals
  const mainLocals = extractDeclaredNames(program, true);
  const mainEnv = extendEnvironment(globalEnv, mainLocals);

  // Resolve all identifiers in the program and collect functions
  const resolveInNode = (node: any, env: Environment) => {
    if (!node || typeof node !== 'object') return;

    if (node.type === 'Identifier') {
      try {
        const resolved = resolveIdentifier(env, node);
        resolvedIdentifiers.set(node, resolved);
      } catch (error) {
        // Will be handled during compilation if it's a constant primitive
      }
      return;
    }

    if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionDeclaration') {
      // Assign function index
      const functionIndex = functionCounter++;
      
      // Build function environment
      const params = new Map<string, SymbolInfo>();
      for (let i = 0; i < node.params.length; i++) {
        const param = node.params[i] as es.Identifier;
        params.set(param.name, { index: i, isVar: true });
      }
      
      const body = node.type === 'ArrowFunctionExpression' && node.body.type !== 'BlockStatement'
        ? { type: 'BlockStatement', body: [{ type: 'ReturnStatement', argument: node.body }] } as es.BlockStatement
        : node.body as es.BlockStatement;
      
      const bodyLocals = extractDeclaredNames(body, true);
      
      // Merge params and body locals
      for (const [name, info] of bodyLocals) {
        if (!params.has(name)) {
          params.set(name, { ...info, index: info.index + node.params.length });
        }
      }
      
      const functionEnv = extendEnvironment(env, params);
      
      functions.push({
        functionIndex,
        envSize: params.size,
        numArgs: node.params.length,
        ast: body,
        environment: functionEnv,
      });
      
      // Continue resolving in function body
      resolveInNode(body, functionEnv);
      return;
    }

    if (node.type === 'BlockStatement') {
      // Create new scope for block
      const blockLocals = extractDeclaredNames(node, true);
      const blockEnv = blockLocals.size > 0 ? extendEnvironment(env, blockLocals) : env;
      
      for (const stmt of node.body) {
        resolveInNode(stmt, blockEnv);
      }
      return;
    }

    // Recursively process all properties
    for (const key in node) {
      if (node.hasOwnProperty(key) && key !== 'parent') {
        const value = node[key];
        if (Array.isArray(value)) {
          for (const item of value) {
            resolveInNode(item, env);
          }
        } else {
          resolveInNode(value, env);
        }
      }
    }
  };

  // Start analysis
  resolveInNode(program, mainEnv);

  const mainFunction: FunctionInfo = {
    functionIndex: functionCounter++,
    envSize: mainLocals.size,
    numArgs: 0,
    ast: program,
    environment: mainEnv,
  };

  return {
    mainFunction,
    functions,
    resolvedIdentifiers,
  };
};
