import { ExprNS, StmtNS } from "../../ast-types";
import type { Speculation } from "../framework/assumption-chain";
import type { BasicBlock } from "../framework/cfg";
import {
  makeBlockFixpointAnalysis,
  type BlockFixpointAnalysis,
  type BlockPassResult,
} from "../framework/dfa-factory";
import { MutableEnv } from "../framework/mutable-env";
import { isLocal, type SlotLookup } from "../framework/slot-table";
import { LIVE, livenessLattice, type LiveVal } from "./lattice";

/** Marks every `Variable` read as live in the shared env. All other visit
 *  methods just recurse into children; return value is ignored. */
class ReadCollector implements ExprNS.Visitor<void> {
  constructor(
    private readonly env: MutableEnv<LiveVal>,
    private readonly slotLookup: SlotLookup,
  ) {}

  visitVariableExpr(expr: ExprNS.Variable): void {
    const info = this.slotLookup(expr.name);
    if (isLocal(info)) this.env.set(info.slot, LIVE);
  }

  visitBinaryExpr(expr: ExprNS.Binary): void {
    expr.left.accept(this);
    expr.right.accept(this);
  }
  visitCompareExpr(expr: ExprNS.Compare): void {
    expr.left.accept(this);
    expr.right.accept(this);
  }
  visitBoolOpExpr(expr: ExprNS.BoolOp): void {
    expr.left.accept(this);
    expr.right.accept(this);
  }
  visitUnaryExpr(expr: ExprNS.Unary): void {
    expr.right.accept(this);
  }
  visitGroupingExpr(expr: ExprNS.Grouping): void {
    expr.expression.accept(this);
  }
  visitTernaryExpr(expr: ExprNS.Ternary): void {
    expr.predicate.accept(this);
    expr.consequent.accept(this);
    expr.alternative.accept(this);
  }
  visitCallExpr(expr: ExprNS.Call): void {
    expr.callee.accept(this);
    for (const arg of expr.args) arg.accept(this);
  }
  visitListExpr(expr: ExprNS.List): void {
    for (const el of expr.elements) el.accept(this);
  }
  visitSubscriptExpr(expr: ExprNS.Subscript): void {
    expr.value.accept(this);
    expr.index.accept(this);
  }
  visitStarredExpr(expr: ExprNS.Starred): void {
    expr.value.accept(this);
  }
  visitLiteralExpr(_expr: ExprNS.Literal): void {}
  visitBigIntLiteralExpr(_expr: ExprNS.BigIntLiteral): void {}
  visitNoneExpr(_expr: ExprNS.None): void {}
  visitComplexExpr(_expr: ExprNS.Complex): void {}
  // Lambda / MultiLambda bodies are their own scope; their names resolve
  // against a different env than this unit's `slotLookup`. We under-approx
  // here and DSE compensates by refusing to drop lambda-RHS assigns (see
  // dead-store.ts `isPureRhs`).
  visitLambdaExpr(_expr: ExprNS.Lambda): void {}
  visitMultiLambdaExpr(_expr: ExprNS.MultiLambda): void {}
}

/** Backward per-statement transfer: env in = live-OUT, env out = live-IN.
 *  For Assign: kill LHS before visiting RHS so a self-assign `s = s + 1`
 *  keeps `s` live on the way in. */
function killLocal(
  env: MutableEnv<LiveVal>,
  slotLookup: SlotLookup,
  name: Parameters<SlotLookup>[0],
): void {
  const info = slotLookup(name);
  if (isLocal(info)) env.clear(info.slot);
}

function transferStmtBackward(
  stmt: StmtNS.Stmt,
  env: MutableEnv<LiveVal>,
  visitor: ReadCollector,
  slotLookup: SlotLookup,
): void {
  switch (stmt.kind) {
    case "Assign": {
      const a = stmt as StmtNS.Assign;
      if (a.target instanceof ExprNS.Variable) {
        killLocal(env, slotLookup, a.target.name);
      } else {
        // Non-Variable targets (subscript, tuple, ...): no kill, reads only.
        a.target.accept(visitor);
      }
      a.value.accept(visitor);
      return;
    }
    case "AnnAssign": {
      const a = stmt as StmtNS.AnnAssign;
      killLocal(env, slotLookup, a.target.name);
      a.value.accept(visitor);
      return;
    }
    case "If":
      (stmt as StmtNS.If).condition.accept(visitor);
      return;
    case "While":
      (stmt as StmtNS.While).condition.accept(visitor);
      return;
    case "For": {
      const f = stmt as StmtNS.For;
      killLocal(env, slotLookup, f.target);
      f.iter.accept(visitor);
      return;
    }
    case "Return": {
      const r = stmt as StmtNS.Return;
      if (r.value) r.value.accept(visitor);
      return;
    }
    case "SimpleExpr":
      (stmt as StmtNS.SimpleExpr).expression.accept(visitor);
      return;
    case "Assert":
      (stmt as StmtNS.Assert).value.accept(visitor);
      return;
    case "FunctionDef":
    case "Pass":
    case "Break":
    case "Continue":
    case "Global":
    case "NonLocal":
    case "FromImport":
    case "FileInput":
      return;
  }
}

function transferBlock(
  block: BasicBlock,
  inEnv: MutableEnv<LiveVal>,
  slotLookup: SlotLookup,
): BlockPassResult<LiveVal> {
  // `inEnv` is live-OUT; snapshot and mutate into live-IN.
  const outEnv = inEnv.snapshot();
  const visitor = new ReadCollector(outEnv, slotLookup);
  const stmts = block.stmts;
  for (let i = stmts.length - 1; i >= 0; i--) {
    transferStmtBackward(stmts[i], outEnv, visitor, slotLookup);
  }
  return { outEnv, exprFacts: new Map() };
}

/** Backward may-liveness. Stored `outEnv` is the block's live-IN; its
 *  live-OUT is the join of CFG-successors' live-INs (see `liveOutOf`). */
export const livenessAnalysis: BlockFixpointAnalysis<LiveVal> =
  makeBlockFixpointAnalysis<LiveVal>({
    direction: "backward",
    mergeKind: "may",
    valueLattice: livenessLattice,
    seedEnv: () => new MutableEnv<LiveVal>(),
    transferBlock: (_ctx, block, inEnv, unit) =>
      transferBlock(block, inEnv, unit.slotLookup),
    refineOnEdge: (env, _edge) => env,
  });

/** Reconstruct live-OUT of `block` under `chain`: join of successors'
 *  live-INs at that chain. Terminal blocks return empty. `chain` is
 *  load-bearing — successor live-INs differ across speculative contexts. */
export function liveOutOf(
  block: BasicBlock,
  chain: Speculation,
): MutableEnv<LiveVal> {
  const result = new MutableEnv<LiveVal>();
  for (const edge of block.successorEdges) {
    const env = livenessAnalysis.env.read(edge.to, chain);
    for (const slot of env.definedSlots()) result.set(slot, LIVE);
  }
  return result;
}

/** Per-statement backward walk: returns live-OUT of each stmt (= live-IN of
 *  the next). Returned sets are fresh, never alias analysis-store state. */
export function perStatementLiveOut(
  block: BasicBlock,
  slotLookup: SlotLookup,
  chain: Speculation,
): ReadonlyArray<ReadonlySet<number>> {
  const stmts = block.stmts;
  const liveOuts: Set<number>[] = new Array(stmts.length);
  const env = liveOutOf(block, chain);
  const visitor = new ReadCollector(env, slotLookup);
  for (let i = stmts.length - 1; i >= 0; i--) {
    liveOuts[i] = new Set(env.definedSlots());
    transferStmtBackward(stmts[i], env, visitor, slotLookup);
  }
  return liveOuts;
}

