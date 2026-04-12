// src/specialization/framework/scope-index-map.ts — bidirectional scope ↔ function index map

import { StmtNS } from "../../ast-types";

type Scope = StmtNS.FileInput | StmtNS.FunctionDef;

/**
 * Bidirectional map between AST scope nodes and SVML function indices.
 *
 * Built during compilation (the compiler records each scope → index mapping
 * as it creates function builders). Consumed by JIT recompilation to target
 * `SVMLProgram.withSpecializedFunction()` at the correct slot.
 */
export class ScopeIndexMap {
  private readonly scopeToIndex = new Map<Scope, number>();
  private readonly indexToScope = new Map<number, Scope>();

  register(scope: Scope, functionIndex: number): void {
    this.scopeToIndex.set(scope, functionIndex);
    this.indexToScope.set(functionIndex, scope);
  }

  getIndex(scope: Scope): number | undefined {
    return this.scopeToIndex.get(scope);
  }

  getScope(index: number): Scope | undefined {
    return this.indexToScope.get(index);
  }

  get size(): number {
    return this.scopeToIndex.size;
  }
}
