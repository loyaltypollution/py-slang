import { StmtNS, ExprNS } from "../ast-types";
import { Token } from "../tokenizer";

/**
 * AST-level instrumentation for analyzing and optimizing compiled functions
 * 
 * This works during compilation by tracking the visitor pattern, giving us
 * rich semantic information about function definitions and calls.
 */

/**
 * Information about a function being compiled
 */
export interface FunctionInfo {
  name: string;
  functionIndex: number;
  parameters: string[];
  callsTo: Set<string>; // Names of functions this function calls
  isRecursive: boolean;
  needsMemoization: boolean;
  node: StmtNS.FunctionDef | ExprNS.Lambda | ExprNS.MultiLambda;
}

/**
 * Information about a call site
 */
interface CallSite {
  calleeName: string;
  numArgs: number;
  location: Token;
}

/**
 * Instrumentation tracker that monitors AST traversal during compilation
 */
export class InstrumentationTracker {
  // Stack of currently compiling functions
  private functionStack: FunctionInfo[] = [];
  
  // Map of all functions seen: name -> FunctionInfo
  private functions = new Map<string, FunctionInfo>();
  
  // Map of function index -> FunctionInfo
  private functionsByIndex = new Map<number, FunctionInfo>();
  
  // Configuration
  private config: InstrumentationConfig;

  constructor(config: InstrumentationConfig = DEFAULT_INSTRUMENTATION_CONFIG) {
    this.config = config;
  }

  /**
   * Called when entering a function definition during compilation
   */
  enterFunction(
    node: StmtNS.FunctionDef | ExprNS.Lambda | ExprNS.MultiLambda,
    functionIndex: number
  ): void {
    let name: string;
    let parameters: string[];

    if (node instanceof StmtNS.FunctionDef) {
      name = node.name.lexeme;
      parameters = node.parameters.map(p => p.lexeme);
    } else if (node instanceof ExprNS.Lambda) {
      name = `<lambda_${functionIndex}>`;
      parameters = node.parameters.map(p => p.lexeme);
    } else {
      name = `<multilambda_${functionIndex}>`;
      parameters = node.parameters.map(p => p.lexeme);
    }

    const funcInfo: FunctionInfo = {
      name,
      functionIndex,
      parameters,
      callsTo: new Set(),
      isRecursive: false,
      needsMemoization: false,
      node,
    };

    this.functionStack.push(funcInfo);
    this.functions.set(name, funcInfo);
    this.functionsByIndex.set(functionIndex, funcInfo);
  }

  /**
   * Called when exiting a function definition during compilation
   */
  exitFunction(): FunctionInfo | undefined {
    const funcInfo = this.functionStack.pop();
    
    if (!funcInfo) {
      return undefined;
    }

    // Check if this function is recursive (calls itself)
    if (funcInfo.callsTo.has(funcInfo.name)) {
      funcInfo.isRecursive = true;

      // Determine if we should memoize
      if (
        this.config.enableMemoization &&
        (!this.config.memoizationThreshold || 
         funcInfo.parameters.length <= this.config.memoizationThreshold)
      ) {
        funcInfo.needsMemoization = true;
      }
    }

    return funcInfo;
  }

  /**
   * Called when visiting a call expression during compilation
   */
  recordCall(callExpr: ExprNS.Call): void {
    // Only track calls to simple identifiers (Variable nodes)
    if (!(callExpr.callee instanceof ExprNS.Variable)) {
      return;
    }

    const calleeName = callExpr.callee.name.lexeme;
    const currentFunction = this.currentFunction();

    if (currentFunction) {
      currentFunction.callsTo.add(calleeName);
      
    }
  }

  /**
   * Get the currently compiling function
   */
  currentFunction(): FunctionInfo | undefined {
    return this.functionStack[this.functionStack.length - 1];
  }

  /**
   * Get all recorded functions
   */
  getAllFunctions(): FunctionInfo[] {
    return Array.from(this.functions.values());
  }

  /**
   * Get recursive functions that need memoization
   */
  getRecursiveFunctions(): FunctionInfo[] {
    return this.getAllFunctions().filter(f => f.isRecursive);
  }

  /**
   * Get functions that should be memoized
   */
  getFunctionsToMemoize(): FunctionInfo[] {
    return this.getAllFunctions().filter(f => f.needsMemoization);
  }

  /**
   * Get function info by index
   */
  getFunctionByIndex(index: number): FunctionInfo | undefined {
    return this.functionsByIndex.get(index);
  }

  /**
   * Get function info by name
   */
  getFunctionByName(name: string): FunctionInfo | undefined {
    return this.functions.get(name);
  }

  /**
   * Print summary of instrumentation results
   */
  printSummary(): void {
  }

  /**
   * Build a call graph of the program
   */
  buildCallGraph(): Map<string, Set<string>> {
    const callGraph = new Map<string, Set<string>>();
    
    for (const func of this.functions.values()) {
      callGraph.set(func.name, new Set(func.callsTo));
    }
    
    return callGraph;
  }

  /**
   * Detect indirect recursion (mutual recursion)
   * e.g., A calls B, B calls A
   */
  detectMutualRecursion(): Set<Set<string>> {
    const callGraph = this.buildCallGraph();
    const mutualRecursionSets = new Set<Set<string>>();
    const visited = new Set<string>();

    function dfs(
      node: string,
      path: Set<string>,
      graph: Map<string, Set<string>>
    ): void {
      if (path.has(node)) {
        // Found a cycle - extract the cycle
        const cycle = new Set<string>();
        let inCycle = false;
        for (const n of path) {
          if (n === node) inCycle = true;
          if (inCycle) cycle.add(n);
        }
        cycle.add(node);
        mutualRecursionSets.add(cycle);
        return;
      }

      if (visited.has(node)) {
        return;
      }

      path.add(node);
      const neighbors = graph.get(node) || new Set();
      for (const neighbor of neighbors) {
        dfs(neighbor, new Set(path), graph);
      }
      path.delete(node);
      visited.add(node);
    }

    for (const funcName of callGraph.keys()) {
      dfs(funcName, new Set(), callGraph);
    }


    return mutualRecursionSets;
  }
}

/**
 * Instrumentation configuration
 */
export interface InstrumentationConfig {
  enableMemoization: boolean;
  enableRecursionDetection: boolean;
  logRecursiveCalls: boolean;
  memoizationThreshold?: number; // Only memoize if param count <= threshold
}

export const DEFAULT_INSTRUMENTATION_CONFIG: InstrumentationConfig = {
  enableMemoization: true,
  enableRecursionDetection: true,
  logRecursiveCalls: true,
  memoizationThreshold: 10,
};

/**
 * Runtime memoization wrapper
 * This is applied by the VM when executing memoized functions
 */
export function createMemoizedWrapper(
  originalFunc: Function,
  functionName: string = "anonymous"
): Function {
  const cache = new Map<string, any>();
  
  const memoizedFunc = function(this: any, ...args: any[]) {
    // Create cache key from arguments
    const key = JSON.stringify(args);
    
    if (cache.has(key)) {
      return cache.get(key);
    }
    
    const result = originalFunc.apply(this, args);
    cache.set(key, result);
    
    return result;
  };

  // Attach metadata for debugging
  Object.defineProperty(memoizedFunc, 'name', { value: `memoized_${functionName}` });
  (memoizedFunc as any).__memoCache = cache;
  (memoizedFunc as any).__originalFunc = originalFunc;
  
  
  return memoizedFunc;
}

/**
 * Get statistics about a memoized function's cache
 */
export function getMemoizationStats(func: any): {
  functionName: string;
  cacheSize: number;
  hitRate?: number;
} | null {
  if (!func.__memoCache) {
    return null;
  }

  return {
    functionName: func.name || "anonymous",
    cacheSize: func.__memoCache.size,
  };
}

/**
 * Clear memoization cache
 */
export function clearMemoizationCache(func: any): void {
  if (func.__memoCache) {
    func.__memoCache.clear();
  }
}
