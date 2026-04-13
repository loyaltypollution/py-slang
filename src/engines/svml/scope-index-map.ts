// src/engines/svml/scope-index-map.ts — bidirectional scope ↔ function index map

import { StmtNS } from "../../ast-types";

/**
 * Bidirectional map between AST scope nodes and SVML function indices.
 *
 * Built during compilation (the compiler records each scope → index mapping
 * as it creates function builders). Consumed by JIT recompilation to target
 * `SVMLProgram.withSpecializedFunction()` at the correct slot.
 */
export class ScopeIndexMap {
  private readonly scopeToIndex = new Map<StmtNS.FileInput | StmtNS.FunctionDef, number>();
  private readonly indexToScope = new Map<number, StmtNS.FileInput | StmtNS.FunctionDef>();

  register(scope: StmtNS.FileInput | StmtNS.FunctionDef, functionIndex: number): void {
    this.scopeToIndex.set(scope, functionIndex);
    this.indexToScope.set(functionIndex, scope);
  }

  getIndex(scope: StmtNS.FileInput | StmtNS.FunctionDef): number | undefined {
    return this.scopeToIndex.get(scope);
  }

  getScope(index: number): StmtNS.FileInput | StmtNS.FunctionDef | undefined {
    return this.indexToScope.get(index);
  }

  get size(): number {
    return this.scopeToIndex.size;
  }
}
