import { ExprNS, StmtNS } from "../../../ast-types";
import type { Token } from "../../../tokenizer";
import type { AssumptionChain } from "../../assumption/chain";
import type { BasicBlock } from "../../program/views/basic-block";
import { MutableEnv } from "../../analysis/mutable-env";
import { isLocal, type SlotLookup } from "../../program/slot-table";
import {
    makeBlockFixpointAnalysis,
    type BlockFixpointAnalysis,
} from "../dfa-factory";
import { LIVE, livenessLattice, type LiveVal } from "./lattice";

/** Marks every `Variable` read live in the shared env; other visits recurse. */
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

function killLocal(
  env: MutableEnv<LiveVal>,
  slotLookup: SlotLookup,
  name: Token,
): void {
  const info = slotLookup(name);
  if (isLocal(info)) env.clear(info.slot);
}

/** Backward per-statement transfer: env in = live-OUT, env out = live-IN.
 *  Assign kills LHS before visiting RHS so `s = s + 1` keeps `s` live in. */
function transferStmtBackward(
  stmt: StmtNS.Stmt,
  env: MutableEnv<LiveVal>,
  visitor: ReadCollector,
  slotLookup: SlotLookup,
): void {
  if (stmt instanceof StmtNS.Assign) {
    if (stmt.target instanceof ExprNS.Variable) {
      killLocal(env, slotLookup, stmt.target.name);
    } else {
      // Non-Variable targets (subscript, tuple, ...): no kill, reads only.
      stmt.target.accept(visitor);
    }
    stmt.value.accept(visitor);
    return;
  }
  if (stmt instanceof StmtNS.AnnAssign) {
    killLocal(env, slotLookup, stmt.target.name);
    stmt.value.accept(visitor);
    return;
  }
  if (stmt instanceof StmtNS.If || stmt instanceof StmtNS.While) {
    stmt.condition.accept(visitor);
    return;
  }
  if (stmt instanceof StmtNS.For) {
    killLocal(env, slotLookup, stmt.target);
    stmt.iter.accept(visitor);
    return;
  }
  if (stmt instanceof StmtNS.Return) {
    if (stmt.value) stmt.value.accept(visitor);
    return;
  }
  if (stmt instanceof StmtNS.SimpleExpr) {
    stmt.expression.accept(visitor);
    return;
  }
  if (stmt instanceof StmtNS.Assert) {
    stmt.value.accept(visitor);
    return;
  }
  // FunctionDef, Pass, Break, Continue, Global, NonLocal, FromImport,
  // FileInput: no reads, no kills.
}

/** Backward may-liveness. Stored `outEnv` is the block's live-IN. */
export const livenessAnalysis: BlockFixpointAnalysis<LiveVal> =
  makeBlockFixpointAnalysis<LiveVal>({
    direction: "backward",
    mergeKind: "may",
    valueLattice: livenessLattice,
    seedEnv: () => new MutableEnv<LiveVal>(),
    transferBlock: (_ctx, block, inEnv, unit) => {
      // `inEnv` is live-OUT; snapshot and mutate into live-IN.
      const outEnv = inEnv.snapshot();
      const { slotLookup } = unit;
      const visitor = new ReadCollector(outEnv, slotLookup);
      const stmts = block.stmts;
      for (let i = stmts.length - 1; i >= 0; i--) {
        transferStmtBackward(stmts[i], outEnv, visitor, slotLookup);
      }
      return { outEnv, exprFacts: new Map() };
    },
  });

/** Per-statement backward walk: returns live-OUT of each stmt (= live-IN of
 *  the next). Returned sets are fresh, never alias analysis-store state.
 *  `chain` is load-bearing — successor live-INs differ across speculative
 *  contexts. */
export function perStatementLiveOut(
  block: BasicBlock,
  slotLookup: SlotLookup,
  chain: AssumptionChain,
): ReadonlyArray<ReadonlySet<number>> {
  // Reconstruct live-OUT of `block`: join of successors' live-INs at `chain`.
  // Terminal blocks start empty.
  const env = new MutableEnv<LiveVal>();
  for (const edge of block.successorEdges) {
    const succEnv = livenessAnalysis.env.store.read(edge.to, chain);
    for (const slot of succEnv.definedSlots()) env.set(slot, LIVE);
  }
  const stmts = block.stmts;
  const liveOuts: Set<number>[] = new Array(stmts.length);
  const visitor = new ReadCollector(env, slotLookup);
  for (let i = stmts.length - 1; i >= 0; i--) {
    liveOuts[i] = new Set(env.definedSlots());
    transferStmtBackward(stmts[i], env, visitor, slotLookup);
  }
  return liveOuts;
}
