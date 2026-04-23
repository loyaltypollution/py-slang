// Constant folding of Binary expressions to Literals. Idempotent (the Literal
// no longer matches). Witness-aware: each fold publishes at the shallowest
// chain that proves the expression constant.

import { ExprNS, StmtNS } from "../../ast-types";
import type { ConstLattice } from "../const-analysis/lattice";
import type { TransformRule } from "../framework/analysis";
import { unitOfBlock, wakeOwningUnit } from "../framework/analysis";
import type { Speculation } from "../framework/assumption-chain";
import { visibleBody } from "../framework/assumption-bodies";
import { constAnalysis } from "../framework/dfa-analyses";
import type { Unit } from "../framework/function-unit";
import type { ProgramTopology } from "../framework/topology";
import {
  DescendingExprVisitor,
  RewriteStmtVisitor,
  runWitnessSweep,
  walkExprs,
} from "./witness-utils";

type ConstWitness = { value: Extract<ConstLattice, { tag: "const" }>; witness: Speculation };

function constInfo(
  chain: Speculation,
  topology: ProgramTopology,
  nodeId: number,
): ConstWitness | undefined {
  return constAnalysis
    .perExpr(topology)
    .readMinimal(chain, nodeId, (cv: ConstLattice) => cv.tag === "const") as
    | ConstWitness
    | undefined;
}

function collectWitnesses(
  chain: Speculation,
  topology: ProgramTopology,
  stmts: readonly StmtNS.Stmt[],
  out: Set<Speculation>,
): void {
  walkExprs(stmts, (e) => {
    if (!(e instanceof ExprNS.Binary)) return;
    const info = constInfo(chain, topology, e.id);
    if (info !== undefined) out.add(info.witness);
  });
}

class ConstFoldExprVisitor extends DescendingExprVisitor {
  changed = false;

  constructor(
    private readonly chain: Speculation,
    private readonly topology: ProgramTopology,
  ) {
    super();
  }

  visitBinaryExpr(expr: ExprNS.Binary): ExprNS.Expr {
    expr.left = expr.left.accept(this);
    expr.right = expr.right.accept(this);
    const cv = constInfo(this.chain, this.topology, expr.id);
    if (cv === undefined || cv.witness !== this.chain) return expr;
    this.changed = true;
    return new ExprNS.Literal(expr.startToken, expr.endToken, cv.value.value);
  }
}

class ConstFoldStmtVisitor extends RewriteStmtVisitor {
  private readonly exprVisitor: ConstFoldExprVisitor;

  constructor(chain: Speculation, topology: ProgramTopology) {
    const exprVisitor = new ConstFoldExprVisitor(chain, topology);
    super((e) => exprVisitor.rewrite(e));
    this.exprVisitor = exprVisitor;
  }

  get changed(): boolean {
    return this.exprVisitor.changed;
  }
}

export const constantFoldingRule: TransformRule = {
  sweep(unit: Unit, chain: Speculation, topology: ProgramTopology): boolean {
    const witnesses = new Set<Speculation>();
    collectWitnesses(chain, topology, visibleBody(unit, chain), witnesses);
    return runWitnessSweep(
      unit,
      witnesses,
      (witness) => new ConstFoldStmtVisitor(witness, topology),
    );
  },
  bind(wl) {
    wl.onTransformFactDirty(
      constantFoldingRule,
      constAnalysis.facts,
      wakeOwningUnit(unitOfBlock),
    );
  },
};
