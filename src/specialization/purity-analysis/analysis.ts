// src/specialization/purity-analysis/analysis.ts
//
// Intraprocedural purity analysis as a CFG-walking helper. The legacy
// `PurityScopePass` class (a `ScopePass` registered on the worklist) has
// been demolished in PR-6a: its body now lives inside
// `purityScopePass.transfer` (see `../framework/migrated-passes.ts`),
// which calls `computePurity(unit)` below.
//
// Fires once per `(unit, generation)` whenever `structuralPass` produces a
// lattice-change write for the unit, and once at initial converge (seeded
// by the worklist's legacy `processTransform` step). Walks `unit.cfg`
// directly: initialises every block's IN at ⊥ (`BOTTOM_FACT`), propagates
// per-statement transfer, joins at merges, iterates to fixpoint on a FIFO
// worklist, then derives a boolean `pure` verdict from the fact flowing
// out of the CFG exit block.
//
// Grammar note: this AST has no `Raise`, `Yield`, `Try`/`Except`, or
// attribute-store. The only disqualifying effects the language can
// express are subscript-store, `assert`, nonlocal/global access,
// `lambda`, `List` literal, nested `FunctionDef`, `Starred`, `Global`,
// `NonLocal`, and `FromImport`. All collapse into the fact's sticky
// `impure` flag.
//
// Consumer: `MemoizationTransformRule.matches` reads `hint.pure`, which
// routes through the migrated `purityScopePass` fact cell.

import { ExprNS, StmtNS } from "../../ast-types";
import type { BasicBlock } from "../framework/cfg";
import type { FunctionUnit } from "../framework/function-unit";
import type { SlotInfo, SlotLookup } from "../framework/slot-table";
import {
  BOTTOM_FACT,
  IMPURE_CALL,
  WHITELISTED,
  addMod,
  bumpCalls,
  factEquals,
  joinFact,
  markImpure,
  type PurityFact,
} from "./lattice";

// Memo-safe builtins: deterministic, no I/O, no caller-state mutation.
// `print` is deliberately excluded (I/O). `__memo_*` intrinsics are
// whitelisted so a body already rewritten by MemoizationTransformRule
// continues to classify as pure on subsequent passes.
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

/**
 * Compute a purity verdict for `unit`. Returns `undefined` for non-
 * FunctionDef scopes (FileInput has no meaningful purity). Invoked from
 * `purityScopePass.transfer` after the expression-level DFA fixpoint has
 * converged for the scope — reads only the CFG + slot table, so its only
 * declared framework read is `structuralPass`.
 */
export function computePurity(unit: FunctionUnit): boolean | undefined {
  const fd = unit.funcAst;
  if (!(fd instanceof StmtNS.FunctionDef)) return undefined;
  const self = fd.name.lexeme;
  const exitFact = solveCfg(unit, self);
  return !exitFact.impure && exitFact.calls !== IMPURE_CALL;
}

function solveCfg(unit: FunctionUnit, selfName: string): PurityFact {
  const outByBlock = new Map<number, PurityFact>();
  for (const block of unit.cfg.blocks) outByBlock.set(block.id, BOTTOM_FACT);

  const queue: BasicBlock[] = [unit.cfg.entry];
  const inQueue = new Set<number>([unit.cfg.entry.id]);

  const transfer = makeBlockTransfer(unit.slotLookup, selfName);

  while (queue.length > 0) {
    const block = queue.shift()!;
    inQueue.delete(block.id);

    let inFact: PurityFact = BOTTOM_FACT;
    for (const pred of block.predecessors) {
      inFact = joinFact(inFact, outByBlock.get(pred.id) ?? BOTTOM_FACT);
    }

    const outFact = transfer(block, inFact);
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

// ── Transfer ────────────────────────────────────────────────────────────

type StmtTransfer = (stmt: StmtNS.Stmt, fact: PurityFact) => PurityFact;
type ExprTransfer = (expr: ExprNS.Expr, fact: PurityFact) => PurityFact;

function makeBlockTransfer(
  slotLookup: SlotLookup,
  selfName: string,
): (block: BasicBlock, inFact: PurityFact) => PurityFact {
  const exprTransfer = makeExprTransfer(slotLookup, selfName);
  const stmtTransfer = makeStmtTransfer(slotLookup, exprTransfer);
  return (block, inFact) => {
    let fact = inFact;
    for (const stmt of block.stmts) fact = stmtTransfer(stmt, fact);
    return fact;
  };
}

function makeStmtTransfer(slotLookup: SlotLookup, exprT: ExprTransfer): StmtTransfer {
  const isLocal = (info: SlotInfo) => !info.isPrimitive && info.envLevel === 0;

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
        // Subscript-store: target may alias a caller-owned object (the
        // grammar has no way to prove local construction without an escape
        // model). Evaluate children, then mark impure.
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
        // Bare expression-statement has no consumer for its value. Parity
        // with the prior structural-fold rule: disqualify.
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

function makeExprTransfer(slotLookup: SlotLookup, selfName: string): ExprTransfer {
  const isLocal = (info: SlotInfo) => !info.isPrimitive && info.envLevel === 0;

  const walk: ExprTransfer = (expr, fact) => {
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
      // Classify callee without routing it through the Variable rule (which
      // would flag nonlocal/primitive reads as impure). Self-recursion and
      // whitelisted builtins stay pure.
      let f = fact;
      if (expr.callee instanceof ExprNS.Variable) {
        const name = expr.callee.name.lexeme;
        if (name === selfName || WHITELISTED_BUILTINS.has(name)) {
          f = bumpCalls(f, WHITELISTED);
        } else {
          f = bumpCalls(f, IMPURE_CALL);
        }
      } else {
        // Computed callee (e.g. subscript of a list-of-fns). Walk value
        // subtree; call site disqualifies.
        f = walk(expr.callee, f);
        f = bumpCalls(f, IMPURE_CALL);
      }
      for (const a of expr.args) f = walk(a, f);
      return f;
    }

    if (expr instanceof ExprNS.Subscript) {
      // Read is pure in effect. `visitSubscriptExpr` in the old code marked
      // it IMPURE unconditionally; this rewrite removes that monkey patch.
      let f = walk(expr.value, fact);
      f = walk(expr.index, f);
      return f;
    }

    if (expr instanceof ExprNS.List) {
      // Allocation identity is caller-observable; without an escape model
      // we conservatively disqualify.
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
