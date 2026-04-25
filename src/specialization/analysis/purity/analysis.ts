// Intraprocedural purity. Two-tier:
//   - purityBlockAnalysis: per-block dataflow over AbsVal slots, emitting an
//     IMPURE_SENTINEL fact in any block that performs an observable effect.
//   - purityFunctionAnalysis: per-FunctionDef verdict, joining the block facts
//     over reachable blocks under the current speculation context.

import { ExprNS, StmtNS } from "../../../ast-types";
import type {
  Analysis,
  AnalysisCtx,
  JoinSemiLattice,
} from "../../framework/analysis";
import { defineAnalysis } from "../../framework/analysis";
import { internSingletonNode } from "../../program/node-set";
import type { BasicBlock } from "../../program/views/basic-block";
import type { Function } from "../../program/views/function";
import type { FunctionLocator } from "../../program/views/function-locator";
import { MutableEnv } from "../../analysis/mutable-env";
import { isCapture, isLocal, type SlotLookup } from "../../program/slot-table";
import { constAnalysis } from "../const/analysis";
import {
  makeBlockFixpointAnalysis,
  type BlockFixpointAnalysis,
} from "../dfa-factory";
import { typeAnalysis } from "../type/analysis";
import { BOOL_BIT, BoolRef } from "../type/lattice";
import {
  absValLattice,
  GLOBAL,
  IMPURE_MARKER,
  IMPURE_SENTINEL_NODE_ID,
  UNKNOWN,
  type AbsVal
} from "./lattice";

const WHITELISTED_BUILTINS: ReadonlySet<string> = new Set([
  "range", "len", "abs", "min", "max", "int", "float", "str", "bool", "round",
  "__memo_has", "__memo_get", "__memo_put",
]);

class BlockState {
  impure = false;
  env!: MutableEnv<AbsVal>;
  slotLookup!: SlotLookup;
  selfName: string | undefined;
  ctx!: AnalysisCtx;

  reset(
    env: MutableEnv<AbsVal>,
    slotLookup: SlotLookup,
    selfName: string | undefined,
    ctx: AnalysisCtx,
  ): this {
    this.impure = false;
    this.env = env;
    this.slotLookup = slotLookup;
    this.selfName = selfName;
    this.ctx = ctx;
    return this;
  }
}

class PurityExprVisitor implements ExprNS.Visitor<AbsVal> {
  readonly state = new BlockState();

  visitLiteralExpr(_e: ExprNS.Literal): AbsVal { return UNKNOWN; }
  visitBigIntLiteralExpr(_e: ExprNS.BigIntLiteral): AbsVal { return UNKNOWN; }
  visitComplexExpr(_e: ExprNS.Complex): AbsVal { return UNKNOWN; }
  visitNoneExpr(_e: ExprNS.None): AbsVal { return UNKNOWN; }

  visitVariableExpr(expr: ExprNS.Variable): AbsVal {
    const info = this.state.slotLookup(expr.name);
    if (isLocal(info)) return this.state.env.get(info.slot) ?? UNKNOWN;
    // Capture reads depend on enclosing locals but are not an effect; we don't
    // plumb cross-frame env lookup so widen to Unknown.
    if (isCapture(info)) return UNKNOWN;
    this.state.impure = true;
    return GLOBAL;
  }

  visitGroupingExpr(expr: ExprNS.Grouping): AbsVal {
    return expr.expression.accept(this);
  }

  visitBinaryExpr(expr: ExprNS.Binary): AbsVal {
    expr.left.accept(this);
    expr.right.accept(this);
    return UNKNOWN;
  }
  visitCompareExpr(expr: ExprNS.Compare): AbsVal {
    expr.left.accept(this);
    expr.right.accept(this);
    return UNKNOWN;
  }
  visitBoolOpExpr(expr: ExprNS.BoolOp): AbsVal {
    expr.left.accept(this);
    expr.right.accept(this);
    return UNKNOWN;
  }
  visitUnaryExpr(expr: ExprNS.Unary): AbsVal {
    expr.right.accept(this);
    return UNKNOWN;
  }
  visitTernaryExpr(expr: ExprNS.Ternary): AbsVal {
    expr.predicate.accept(this);
    expr.consequent.accept(this);
    expr.alternative.accept(this);
    return UNKNOWN;
  }
  visitSubscriptExpr(expr: ExprNS.Subscript): AbsVal {
    expr.value.accept(this);
    expr.index.accept(this);
    return UNKNOWN;
  }

  visitListExpr(expr: ExprNS.List): AbsVal {
    for (const el of expr.elements) el.accept(this);
    return { kind: "fresh", origin: expr.id };
  }

  visitCallExpr(expr: ExprNS.Call): AbsVal {
    const state = this.state;
    let calleeName: string | undefined;
    let calleeAbs: AbsVal | undefined;
    if (expr.callee instanceof ExprNS.Variable) {
      calleeName = expr.callee.name.lexeme;
      const info = state.slotLookup(expr.callee.name);
      if (isLocal(info)) calleeAbs = state.env.get(info.slot);
    } else {
      expr.callee.accept(this);
      state.impure = true;
    }

    // closure.pure tri-state: true = resolved pure, false = resolved impure,
    // undefined = not yet analyzed (pending defers impurity to stay monotone).
    const closure = calleeAbs?.kind === "closure" ? calleeAbs : undefined;
    const isPureClosureCall = closure?.pure === true;
    const isPendingClosureCall = closure?.pure === undefined && closure !== undefined;
    const isImpureClosureCall = closure?.pure === false;
    const isWhitelistedBuiltin =
      calleeName !== undefined && WHITELISTED_BUILTINS.has(calleeName);
    const isSelfRecursion = calleeName !== undefined && calleeName === state.selfName;
    const isKnownSafeNamedCall =
      isWhitelistedBuiltin || isSelfRecursion || isPureClosureCall || isPendingClosureCall;

    if (isImpureClosureCall || (calleeName !== undefined && !isKnownSafeNamedCall)) {
      state.impure = true;
    }

    // Without an interprocedural summary, args may escape into mutation —
    // including via self-recursion.
    const argsEscape = !isWhitelistedBuiltin && !isPureClosureCall && !isPendingClosureCall;
    for (const arg of expr.args) {
      arg.accept(this);
      if (!argsEscape || !(arg instanceof ExprNS.Variable)) continue;
      const info = state.slotLookup(arg.name);
      if (isLocal(info) && state.env.get(info.slot)?.kind !== "unknown") {
        state.env.set(info.slot, UNKNOWN);
      }
    }
    return UNKNOWN;
  }

  visitLambdaExpr(_e: ExprNS.Lambda): AbsVal {
    this.state.impure = true;
    return UNKNOWN;
  }
  visitMultiLambdaExpr(_e: ExprNS.MultiLambda): AbsVal {
    this.state.impure = true;
    return UNKNOWN;
  }
  visitStarredExpr(expr: ExprNS.Starred): AbsVal {
    expr.value.accept(this);
    this.state.impure = true;
    return UNKNOWN;
  }
}

function transferStmt(
  stmt: StmtNS.Stmt,
  state: BlockState,
  visitor: PurityExprVisitor,
): void {
  switch (stmt.kind) {
    case "Pass":
    case "Break":
    case "Continue":
    case "FileInput":
      return;

    case "Return": {
      const r = stmt as StmtNS.Return;
      if (r.value !== null) {
        const val = r.value.accept(visitor);
        // Returning a resolved-impure closure escapes it to the caller.
        if (val.kind === "closure" && val.pure === false) state.impure = true;
      }
      return;
    }

    case "Assign": {
      const a = stmt as StmtNS.Assign;
      const val = a.value.accept(visitor);
      if (a.target instanceof ExprNS.Variable) {
        const info = state.slotLookup(a.target.name);
        if (isLocal(info)) state.env.set(info.slot, val);
        else state.impure = true;
        return;
      }
      // Subscript-store: pure iff container is Fresh in this frame.
      const container = a.target.value.accept(visitor);
      a.target.index.accept(visitor);
      if (container.kind !== "fresh") state.impure = true;
      return;
    }

    case "AnnAssign": {
      const a = stmt as StmtNS.AnnAssign;
      const val = a.value.accept(visitor);
      const info = state.slotLookup(a.target.name);
      if (isLocal(info)) state.env.set(info.slot, val);
      else state.impure = true;
      return;
    }

    case "If":
      (stmt as StmtNS.If).condition.accept(visitor);
      return;
    case "While":
      (stmt as StmtNS.While).condition.accept(visitor);
      return;

    case "For": {
      const fs = stmt as StmtNS.For;
      fs.iter.accept(visitor);
      const info = state.slotLookup(fs.target);
      if (isLocal(info)) state.env.set(info.slot, UNKNOWN);
      else state.impure = true;
      return;
    }

    case "SimpleExpr":
      (stmt as StmtNS.SimpleExpr).expression.accept(visitor);
      return;

    case "Assert":
      (stmt as StmtNS.Assert).value.accept(visitor);
      state.impure = true; // Can raise; control-flow observable.
      return;

    case "FunctionDef": {
      const fd = stmt as StmtNS.FunctionDef;
      const info = state.slotLookup(fd.name);
      if (!isLocal(info)) { state.impure = true; return; }
      // `undefined` = scope verdict pending; readDeepest records the dep so
      // this block re-runs when the verdict lands.
      const innerUnit = boundLocator?.functionById(fd.id);
      const innerPure = innerUnit !== undefined
        ? state.ctx.readDeepest(purityFunctionAnalysis, innerUnit)?.value
        : undefined;
      state.env.set(info.slot, { kind: "closure", functionId: fd.id, pure: innerPure });
      return;
    }

    case "Global":
    case "NonLocal":
    case "FromImport":
      state.impure = true;
      return;
  }
}

const EMPTY_EXPR_FACTS: ReadonlyMap<number, AbsVal> = new Map();

const POOLED_PURITY_VISITOR = new PurityExprVisitor();

/** Captured at `purityFunctionAnalysis.bind` time so the per-block transfer
 *  can resolve nested-FunctionDef ids without casting AnalysisCtx. */
let boundLocator: FunctionLocator | undefined;

export const purityBlockAnalysis: BlockFixpointAnalysis<AbsVal> =
  makeBlockFixpointAnalysis<AbsVal>({
  direction: "forward",
  valueLattice: absValLattice,
  mergeKind: "may",
  seedEnv: (unit) => {
    const env = new MutableEnv<AbsVal>();
    const fd = unit.funcAst;
    if (fd instanceof StmtNS.FunctionDef) {
      for (let i = 0; i < fd.parameters.length; i++) {
        env.set(i, { kind: "param", slot: i });
      }
    }
    return env;
  },
  transferBlock: (ctx, block, inEnv, unit) => {
    const fd = unit.funcAst;
    const selfName = fd instanceof StmtNS.FunctionDef ? fd.name.lexeme : undefined;
    const state = POOLED_PURITY_VISITOR.state.reset(
      inEnv,
      unit.slotLookup,
      selfName,
      ctx,
    );
    for (const stmt of block.stmts) transferStmt(stmt, state, POOLED_PURITY_VISITOR);
    const exprFacts = state.impure
      ? new Map<number, AbsVal>([[IMPURE_SENTINEL_NODE_ID, IMPURE_MARKER]])
      : EMPTY_EXPR_FACTS;
    return { outEnv: state.env, exprFacts };
  },
});

// Ordering: undefined ⊏ true ⊏ false. `false` (seen-and-impure) sits at ⊤ so
// memoization's strict `=== true` gate treats both `false` and `undefined` as
// non-firing.
const outerLattice: JoinSemiLattice<boolean | undefined> = {
  bottom: undefined,
  leq: (a, b) => a === undefined || a === b || (a === true && b === false),
  join: (a, b) => {
    if (a === undefined) return b;
    if (b === undefined) return a;
    return a && b;
  },
  eq: (a, b) => a === b,
};

export const purityFunctionAnalysis: Analysis<Function, boolean | undefined> = defineAnalysis({
  storeAlgebra: outerLattice,
  polarity: "may",
  tier: "analysis",
  transfer(ctx: AnalysisCtx, unit: Function): boolean | undefined {
    const fd = unit.funcAst;
    if (!(fd instanceof StmtNS.FunctionDef)) return undefined;
    // Per-context reachability: a block reached only via a const-dead edge
    // under `ctx.currentContext` must not contribute its impure sentinel
    // (e.g. Collatz joining IMPURE under `x : pos-int`).
    const reachable = reachableBlocks(ctx, unit);
    let anyVisited = false;
    for (const block of unit.cfg.blocks) {
      if (!reachable.has(block)) continue;
      // Read directly from the store rather than via `ctx.readDeepest` so
      // we don't record a per-block read edge. Invalidation is declared
      // explicitly through `wl.subscribe` at bind time, gated on the
      // single nodeId we actually care about (`IMPURE_SENTINEL_NODE_ID`);
      // the auto-edge would re-fire on any block-fact advance and defeat
      // that gating.
      const reading = purityBlockAnalysis.facts.store.readDeepest(ctx.currentContext, block);
      if (reading === undefined) continue;
      anyVisited = true;
      if (reading.value.has(IMPURE_SENTINEL_NODE_ID)) return false;
    }
    return anyVisited ? true : undefined;
  },
  bind(wl) {
    boundLocator = wl.locate;
    const unitOf = (unit: Function): Function[] =>
      unit.funcAst instanceof StmtNS.FunctionDef ? [unit] : [];
    wl.onMint(purityFunctionAnalysis, (_ctx, unit) => unitOf(unit));
    wl.onRebuildDirty(purityFunctionAnalysis, (_ctx, unit) => unitOf(unit));
    wl.onSpecRev(purityFunctionAnalysis, (_ctx, unit) => unitOf(unit));
    // Delta-routed wake on per-block purity facts. Interest is the IMPURE
    // sentinel only — the verdict is a join over reachable blocks of
    // "did any block emit IMPURE_SENTINEL?", so a block-fact advance that
    // doesn't touch that sentinel cannot move the verdict.
    wl.subscribe(
      purityBlockAnalysis.facts as Analysis<any, any>,
      purityFunctionAnalysis,
      internSingletonNode(IMPURE_SENTINEL_NODE_ID),
      (_ctx, key) => unitOf((key as BasicBlock).unit),
    );
  },
});

function reachableBlocks(ctx: AnalysisCtx, unit: Function): Set<BasicBlock> {
  const reached = new Set<BasicBlock>([unit.cfg.entry]);
  const queue: BasicBlock[] = [unit.cfg.entry];
  // Head cursor (O(1) amortized) vs shift() which is O(n) in V8.
  let head = 0;
  while (head < queue.length) {
    const block = queue[head++];
    for (const edge of block.successorEdges) {
      if (edge.kind !== "unconditional") {
        const truth = conditionTruth(ctx, edge.condition.id);
        if (truth !== undefined
          && (edge.kind === "branch-true" ? truth === false : truth === true)) continue;
      }
      if (!reached.has(edge.to)) {
        reached.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return reached;
}

// constAnalysis catches `if True:`; typeAnalysis catches predicates that fold
// to BOOL_FALSE under a sign-narrowed param. readPerExprDeepest auto-records
// the dep so this rebuilds when either fact tightens.
function conditionTruth(ctx: AnalysisCtx, nodeId: number): boolean | undefined {
  const cVal = constAnalysis.readPerExprDeepest(ctx, nodeId)?.value;
  if (cVal?.tag === "const" && typeof cVal.value === "boolean") return cVal.value;
  const tVal = typeAnalysis.readPerExprDeepest(ctx, nodeId)?.value;
  if (tVal?.kinds === BOOL_BIT) {
    if (tVal.boolRef === BoolRef.True) return true;
    if (tVal.boolRef === BoolRef.False) return false;
  }
  return undefined;
}
