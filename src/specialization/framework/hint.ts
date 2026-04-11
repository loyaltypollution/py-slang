import type { TypeLattice } from "../type-analysis/lattice";
import type { ConstLattice } from "../const-analysis/lattice";
import type { ExprNS, StmtNS } from "../../ast-types";

export interface OptimizationHint {
  type?: TypeLattice;
  constVal?: ConstLattice;
}

/**
 * Map-based hint storage keyed by node.id.
 *
 * Analysis visitors call `hints.get(node)` / `hints.set(node, hint)`.
 */
export class HintStore {
  private readonly map = new Map<number, OptimizationHint>();

  get(node: ExprNS.Expr | StmtNS.Stmt): OptimizationHint | undefined {
    return this.map.get(node.id);
  }

  set(node: ExprNS.Expr | StmtNS.Stmt, hint: OptimizationHint): this {
    this.map.set(node.id, hint);
    return this;
  }
}
