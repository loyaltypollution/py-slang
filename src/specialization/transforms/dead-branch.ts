import { StmtNS } from "../../ast-types";
import type { TransformRule } from "../framework/analysis";
import type { AssumptionChain } from "../assumption/chain";
import { visibleBody } from "../speculation/assumption-bodies";
import type { Function } from "../program/function/function";
import type { FunctionLocator } from "../program/function/manager";
import { BOOL_BIT, BoolRef, type TypeLattice, typeAnalysis } from "../analysis";
import { BaseStmtVisitor } from "./expr-visitor";
import { groupPlansByWitness, runPerWitness } from "./witness-sweep";

type Plan = { witness: AssumptionChain; replacement: StmtNS.Stmt[] };

function boolCondition(
  view: FunctionLocator,
  chain: AssumptionChain,
  nodeId: number,
): { value: TypeLattice; witness: AssumptionChain } | undefined {
  return typeAnalysis
    .perExpr(view)
    .readMinimal(
      chain,
      nodeId,
      (tv: TypeLattice) =>
        tv.kinds === BOOL_BIT && (tv.boolRef === BoolRef.True || tv.boolRef === BoolRef.False),
    );
}

class DeadBranchMatcher extends BaseStmtVisitor {
  constructor(
    private readonly chain: AssumptionChain,
    private readonly view: FunctionLocator,
    private readonly out: Map<number, Plan>,
  ) {
    super();
  }

  walk(stmts: readonly StmtNS.Stmt[]): void {
    for (const s of stmts) {
      if (s instanceof StmtNS.If) {
        const r = boolCondition(this.view, this.chain, s.condition.id);
        if (r !== undefined) {
          this.out.set(s.id, {
            witness: r.witness,
            replacement: r.value.boolRef === BoolRef.True ? [...s.body] : [...(s.elseBlock ?? [])],
          });
        }
      }
      s.accept(this);
    }
  }

  visitIfStmt(s: StmtNS.If): void {
    this.walk(s.body);
    if (s.elseBlock) this.walk(s.elseBlock);
  }
  visitWhileStmt(s: StmtNS.While): void {
    this.walk(s.body);
  }
  visitForStmt(s: StmtNS.For): void {
    this.walk(s.body);
  }
  visitFileInputStmt(s: StmtNS.FileInput): void {
    this.walk(s.statements);
  }
}

class DeadBranchSplicer extends BaseStmtVisitor {
  changed = false;
  constructor(private readonly replacements: ReadonlyMap<number, StmtNS.Stmt[]>) {
    super();
  }

  sweep(stmts: StmtNS.Stmt[]): void {
    let i = 0;
    while (i < stmts.length) {
      const s = stmts[i];
      if (s instanceof StmtNS.If) {
        const r = this.replacements.get(s.id);
        if (r !== undefined) {
          stmts.splice(i, 1, ...r);
          this.changed = true;
          // Do not advance: spliced-in head may itself be a dead `If`.
          continue;
        }
      }
      s.accept(this);
      i++;
    }
  }

  visitIfStmt(s: StmtNS.If): void {
    this.sweep(s.body);
    if (s.elseBlock) this.sweep(s.elseBlock);
  }
  visitWhileStmt(s: StmtNS.While): void {
    this.sweep(s.body);
  }
  visitForStmt(s: StmtNS.For): void {
    this.sweep(s.body);
  }
  visitFileInputStmt(s: StmtNS.FileInput): void {
    this.sweep(s.statements);
  }
}

export const deadBranchRule: TransformRule = {
  bind(wl) {
    wl.onTransformFactDirty(deadBranchRule, typeAnalysis.facts, (_, b) => [b.unit]);
  },
  sweep(unit: Function, chain: AssumptionChain, view: FunctionLocator) {
    const plans = new Map<number, Plan>();
    new DeadBranchMatcher(chain, view, plans).walk(visibleBody(unit, chain) as StmtNS.Stmt[]);

    return runPerWitness(unit, groupPlansByWitness(plans), (body, replacements) => {
      const splicer = new DeadBranchSplicer(replacements);
      splicer.sweep(body);
      return splicer.changed;
    });
  },
};
