import { ExprNS, StmtNS } from "../../ast-types";
import type { BasicBlock } from "../framework/cfg";
import { addEdge } from "../framework/analysis";
import type { AssumptionChain } from "../framework/context";
import {
  makeBlockFixpointAnalysis,
  nodeIdToBlock,
  type BlockFixpointAnalysis,
  type BlockPassResult,
} from "../framework/dfa-factory";
import type { Unit } from "../framework/function-unit";
import { MutableEnv } from "../framework/mutable-env";
import { runtimeWriteAnalysis } from "../framework/runtime-analyses";
import { isLocal, type SlotLookup } from "../framework/slot-table";
import { LIVE, type LiveVal, livenessLattice } from "./lattice";

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
  // Lambda / MultiLambda bodies are their own scope — their variable names
  // resolve against a different environment than this unit's `slotLookup`.
  // Conservative stance: don't walk their bodies here. If a lambda captures
  // an outer-scope slot, we over-approximate by NOT marking it live, which
  // could cause DSE to drop a capture. To compensate, DSE's `isPureRhs`
  // treats Lambda/MultiLambda as pure only when it can prove no captures;
  // since we don't track captures, the transform must stay conservative on
  // assignments whose RHS is a lambda (see dead-store.ts).
  visitLambdaExpr(_expr: ExprNS.Lambda): void {}
  visitMultiLambdaExpr(_expr: ExprNS.MultiLambda): void {}
}

/** Backward per-statement transfer. Semantics: the env arriving here
 *  represents live-OUT of the statement; after return it is live-IN.
 *
 *  For Assign: kill LHS (remove from live set) before visiting RHS — a
 *  self-assignment `s = s + 1` must leave `s` live on the way in (read
 *  occurs before write in forward execution = read processed after kill
 *  in backward order).
 */
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
        const info = slotLookup(a.target.name);
        if (isLocal(info)) env.clear(info.slot);
      }
      // Non-Variable targets (subscript, tuple, ...): conservative no kill.
      // Their reads are collected normally below.
      if (!(a.target instanceof ExprNS.Variable)) {
        a.target.accept(visitor);
      }
      a.value.accept(visitor);
      return;
    }
    case "AnnAssign": {
      const a = stmt as StmtNS.AnnAssign;
      const info = slotLookup(a.target.name);
      if (isLocal(info)) env.clear(info.slot);
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
      const info = slotLookup(f.target);
      if (isLocal(info)) env.clear(info.slot);
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
  // `inEnv` is factory-provided: represents live-OUT of this block.
  // We mutate it in place into live-IN and publish it as `outEnv`.
  const outEnv = inEnv.snapshot();
  const visitor = new ReadCollector(outEnv, slotLookup);
  const stmts = block.stmts;
  for (let i = stmts.length - 1; i >= 0; i--) {
    transferStmtBackward(stmts[i], outEnv, visitor, slotLookup);
  }
  return { outEnv, exprFacts: new Map() };
}

/** Backward may-liveness analysis. The stored `outEnv` is the block's
 *  live-IN; a block's live-OUT is the join of CFG-successors' live-INs and
 *  can be reconstructed via `liveOutOf` below.
 */
export const livenessAnalysis: BlockFixpointAnalysis<LiveVal> =
  makeBlockFixpointAnalysis<LiveVal>({
    debugName: "liveness",
    direction: "backward",
    mergeKind: "may",
    valueLattice: livenessLattice,
    seedEnv: () => new MutableEnv<LiveVal>(),
    transferBlock: (_ctx, block, inEnv, unit) =>
      transferBlock(block, inEnv, unit.slotLookup),
    refineOnEdge: (env, _edge) => env,
  });

// Runtime writes don't affect liveness, but CFG rebuilds do. The factory's
// own on:rebuild / on:mint edges already handle unit lifecycle. We also wake
// on fact-changes to runtimeWriteAnalysis not for correctness but for parity
// with the forward passes — any observation that drives a transform cascade
// downstream still rebuilds the CFG and re-seeds us via lifecycle.
// Wake the env-side transfer on runtime writes — `.env` owns the block
// transfer; `.facts` is populated as a paired side effect.
addEdge(livenessAnalysis.env, {
  on: "fact",
  analysis: runtimeWriteAnalysis,
  wake: nodeIdToBlock,
});

/** Reconstruct live-OUT of `block` under `chain`: join of live-INs (stored
 *  outEnvs) of CFG-successors read at that chain. Terminal blocks have no
 *  successors ⇒ empty.
 *
 *  `chain` is load-bearing: under a speculative context whose forked body
 *  differs from ROOT, successor live-INs differ accordingly. The previous
 *  ROOT-hardcoded read silently miscompiled any non-ROOT consumer. */
export function liveOutOf(
  block: BasicBlock,
  chain: AssumptionChain,
): MutableEnv<LiveVal> {
  const result = new MutableEnv<LiveVal>();
  for (const edge of block.successorEdges) {
    const env = chain.tryRead(livenessAnalysis.env, edge.to);
    if (env === undefined) continue;
    for (const slot of env.definedSlots()) {
      result.set(slot, LIVE);
    }
  }
  return result;
}

/** Per-statement backward walk over a block; returns a map from statement
 *  index → live-OUT of that statement (= live-IN of the next). Used by the
 *  dead-store transform to decide per-assignment.
 *
 *  Returned live-outs are fresh sets safe for the caller to inspect; they
 *  do not alias any analysis-store state. */
export function perStatementLiveOut(
  block: BasicBlock,
  slotLookup: SlotLookup,
  chain: AssumptionChain,
): ReadonlyArray<ReadonlySet<number>> {
  const stmts = block.stmts;
  const liveOuts: Set<number>[] = new Array(stmts.length);
  const env = liveOutOf(block, chain);
  const visitor = new ReadCollector(env, slotLookup);
  for (let i = stmts.length - 1; i >= 0; i--) {
    const snapshot = new Set<number>();
    for (const s of env.definedSlots()) snapshot.add(s);
    liveOuts[i] = snapshot;
    transferStmtBackward(stmts[i], env, visitor, slotLookup);
  }
  return liveOuts;
}

// Re-export for consumers that need the unit-level context.
export type { Unit };
