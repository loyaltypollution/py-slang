// Intraprocedural purity analysis (FIFO CFG fixpoint per FunctionDef). Consumer: memoizationRule.

import { ExprNS, StmtNS } from "../../ast-types";
import type { BasicBlock } from "../framework/cfg";
import type { FunctionUnit } from "../framework/function-unit";
import type { Lattice, Pass, PassCtx } from "../framework/pass";
import { isLocal, type SlotLookup } from "../framework/slot-table";
import { structuralPass } from "../framework/structural-pass";
import {
  BOTTOM_FACT,
  IMPURE_CALL,
  WHITELISTED,
  addMod,
  bumpCalls,
  factEquals,
  joinFact,
  markImpure,
  type PurityRecord,
} from "./lattice";

// Memo-safe builtins (deterministic, no I/O). __memo_* keep rewritten bodies pure.
const WHITELISTED_BUILTINS: ReadonlySet<string> = new Set([
  "range",
  "len",
  "abs",
  "min",
  "max",
  "int",
  "float",
  "str",
  "bool",
  "round",
  "__memo_has",
  "__memo_get",
  "__memo_put",
]);

// 3-point lattice: ⊥ = undefined, true/false, ⊤ = "contested".
export type PurityLattice = boolean | "contested" | undefined;

const purityLattice: Lattice<PurityLattice> = {
  bottom: undefined,
  equals: (a, b) => a === b,
  join: (a, b) => {
    if (a === undefined) return b;
    if (b === undefined) return a;
    if (a === "contested" || b === "contested") return "contested";
    if (a === b) return a;
    return "contested";
  },
};

// Keyed by the owning FunctionDef.id.
export const purityScopePass: Pass<number, PurityLattice> = {
  id: Symbol("purityScopePass"),
  debugName: "purityScopePass",
  lattice: purityLattice,
  reads: [structuralPass],
  tier: "analysis",
  coarse: false,
  affectedKeys(_ctx, triggerPass, triggerKey) {
    if (triggerPass === (structuralPass as Pass<any, any>)) {
      const fd = (triggerKey as FunctionUnit).funcAst;
      if (fd instanceof StmtNS.FunctionDef) return [fd.id];
    }
    return [];
  },
  transfer(ctx: PassCtx, key: number): PurityLattice {
    const unit = ctx.unitForFdId(key);
    if (unit === undefined) return undefined;
    const fd = unit.funcAst;
    if (!(fd instanceof StmtNS.FunctionDef)) return undefined;
    const exitFact = solveCfg(unit, fd.name.lexeme);
    return !exitFact.impure && exitFact.calls !== IMPURE_CALL;
  },
};

function solveCfg(unit: FunctionUnit, selfName: string): PurityRecord {
  const outByBlock = new Map<number, PurityRecord>();
  for (const block of unit.cfg.blocks) outByBlock.set(block.id, BOTTOM_FACT);

  const queue: BasicBlock[] = [unit.cfg.entry];
  const inQueue = new Set<number>([unit.cfg.entry.id]);

  const step = makeBlockStep(unit.slotLookup, selfName);

  while (queue.length > 0) {
    const block = queue.shift()!;
    inQueue.delete(block.id);

    let inFact: PurityRecord = BOTTOM_FACT;
    for (const pred of block.predecessors) {
      inFact = joinFact(inFact, outByBlock.get(pred.id) ?? BOTTOM_FACT);
    }

    const outFact = step(block, inFact);
    const prev = outByBlock.get(block.id) ?? BOTTOM_FACT;
    if (factEquals(prev, outFact)) continue;

    outByBlock.set(block.id, outFact);
    for (const succ of block.successors) {
      if (!inQueue.has(succ.id)) {
        inQueue.add(succ.id);
        queue.push(succ);
      }
    }
  }

  return outByBlock.get(unit.cfg.exit.id) ?? BOTTOM_FACT;
}

type StmtStep = (stmt: StmtNS.Stmt, fact: PurityRecord) => PurityRecord;
type ExprStep = (expr: ExprNS.Expr, fact: PurityRecord) => PurityRecord;

function makeBlockStep(
  slotLookup: SlotLookup,
  selfName: string,
): (block: BasicBlock, inFact: PurityRecord) => PurityRecord {
  const exprStep = makeExprStep(slotLookup, selfName);
  const stmtStep = makeStmtStep(slotLookup, exprStep);
  return (block, inFact) => {
    let fact = inFact;
    for (const stmt of block.stmts) fact = stmtStep(stmt, fact);
    return fact;
  };
}

function makeStmtStep(slotLookup: SlotLookup, exprT: ExprStep): StmtStep {
  return (stmt, fact) => {
    switch (stmt.kind) {
      case "Pass":
      case "Break":
      case "Continue":
        return fact;

      case "Return": {
        const ret = stmt as StmtNS.Return;
        return ret.value === null ? fact : exprT(ret.value, fact);
      }

      case "Assign": {
        const a = stmt as StmtNS.Assign;
        const f = exprT(a.value, fact);
        if (a.target instanceof ExprNS.Variable) {
          const info = slotLookup(a.target.name);
          if (isLocal(info)) return addMod(f, info.slot);
          return markImpure(f);
        }
        // Subscript-store may alias caller object; disqualify.
        let g = exprT(a.target.value, f);
        g = exprT(a.target.index, g);
        return markImpure(g);
      }

      case "AnnAssign": {
        const a = stmt as StmtNS.AnnAssign;
        const f = exprT(a.value, fact);
        const info = slotLookup(a.target.name);
        if (isLocal(info)) return addMod(f, info.slot);
        return markImpure(f);
      }

      case "If":
        return exprT((stmt as StmtNS.If).condition, fact);
      case "While":
        return exprT((stmt as StmtNS.While).condition, fact);

      case "For": {
        const fs = stmt as StmtNS.For;
        const acc = exprT(fs.iter, fact);
        const info = slotLookup(fs.target);
        if (isLocal(info)) return addMod(acc, info.slot);
        return markImpure(acc);
      }

      case "SimpleExpr": {
        // Bare expression-statement: no value consumer; disqualify.
        const s = stmt as StmtNS.SimpleExpr;
        return markImpure(exprT(s.expression, fact));
      }

      case "Assert": {
        const a = stmt as StmtNS.Assert;
        return markImpure(exprT(a.value, fact));
      }

      case "FunctionDef":
      case "Global":
      case "NonLocal":
      case "FromImport":
        return markImpure(fact);

      case "FileInput":
        return fact;
    }
    return fact;
  };
}

function makeExprStep(slotLookup: SlotLookup, selfName: string): ExprStep {
  const walk: ExprStep = (expr, fact) => {
    if (expr instanceof ExprNS.Literal) return fact;
    if (expr instanceof ExprNS.BigIntLiteral) return fact;
    if (expr instanceof ExprNS.Complex) return fact;
    if (expr instanceof ExprNS.None) return fact;

    if (expr instanceof ExprNS.Variable) {
      const info = slotLookup(expr.name);
      if (isLocal(info)) return fact;
      return markImpure(fact);
    }

    if (expr instanceof ExprNS.Grouping) return walk(expr.expression, fact);
    if (expr instanceof ExprNS.Binary) return walk(expr.right, walk(expr.left, fact));
    if (expr instanceof ExprNS.Compare) return walk(expr.right, walk(expr.left, fact));
    if (expr instanceof ExprNS.BoolOp) return walk(expr.right, walk(expr.left, fact));
    if (expr instanceof ExprNS.Unary) return walk(expr.right, fact);
    if (expr instanceof ExprNS.Ternary) {
      return walk(expr.alternative, walk(expr.consequent, walk(expr.predicate, fact)));
    }

    if (expr instanceof ExprNS.Call) {
      // Self-recursion and whitelisted builtins stay pure; anything else is impure.
      let f = fact;
      if (expr.callee instanceof ExprNS.Variable) {
        const name = expr.callee.name.lexeme;
        const call = name === selfName || WHITELISTED_BUILTINS.has(name) ? WHITELISTED : IMPURE_CALL;
        f = bumpCalls(f, call);
      } else {
        // Computed callee (e.g. subscript of list-of-fns) disqualifies.
        f = bumpCalls(walk(expr.callee, f), IMPURE_CALL);
      }
      for (const a of expr.args) f = walk(a, f);
      return f;
    }

    if (expr instanceof ExprNS.Subscript) {
      return walk(expr.index, walk(expr.value, fact));
    }

    if (expr instanceof ExprNS.List) {
      // Allocation identity is caller-observable; disqualify.
      let f = fact;
      for (const el of expr.elements) f = walk(el, f);
      return markImpure(f);
    }

    if (expr instanceof ExprNS.Lambda) return markImpure(fact);
    if (expr instanceof ExprNS.MultiLambda) return markImpure(fact);
    if (expr instanceof ExprNS.Starred) return markImpure(walk(expr.value, fact));

    return markImpure(fact);
  };

  return walk;
}
