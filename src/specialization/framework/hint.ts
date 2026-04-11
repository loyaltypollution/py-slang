import type { TypeLattice } from "../type-analysis/lattice";
import type { ConstLattice } from "../const-analysis/lattice";
import type { ExprNS, StmtNS } from "../../ast-types";

export type PyASTNode = ExprNS.Expr | StmtNS.Stmt;

export interface OptimizationHint {
  type?: TypeLattice;
  constVal?: ConstLattice;
}

/**
 * HintStore: Map-based hint storage keyed by node.id.
 *
 * Analysis visitors call `hints.get(node)` / `hints.set(node, hint)`.
 * Codegen pulls hints via `hints.getById(node.id)` without an annotation walk.
 */
export class HintStore {
  private readonly map = new Map<number, OptimizationHint>();

  get(node: PyASTNode): OptimizationHint | undefined {
    return this.map.get(node.id);
  }

  set(node: PyASTNode, hint: OptimizationHint): this {
    this.map.set(node.id, hint);
    return this;
  }

  getById(id: number): OptimizationHint | undefined {
    return this.map.get(id);
  }

  has(node: PyASTNode): boolean {
    return this.map.has(node.id);
  }

  get size(): number {
    return this.map.size;
  }

  entries(): IterableIterator<[number, OptimizationHint]> {
    return this.map.entries();
  }
}
