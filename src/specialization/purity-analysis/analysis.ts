// Intraprocedural purity analysis with freshness/escape tracking.
// Nested FunctionDef bodies are analyzed as their own Unit and read back via
// purityScopeAnalysis; Lambda / MultiLambda stay sticky-impure for now.

import { ExprNS, StmtNS } from "../../ast-types";
import { constAnalysis } from "../const-analysis/analysis";
import type {
  AnalysisCtx,
  JoinSemiLattice,
  SemanticAnalysis
} from "../framework/analysis";
import { composeBind, defineAnalysis } from "../framework/analysis";
import type { BasicBlock, CFGEdge } from "../framework/cfg";
import { type Speculation } from "../framework/assumption-chain";
import {
  makeBlockFixpointAnalysis,
  type BlockFixpointAnalysis,
} from "../framework/dfa-factory";
import type { Unit } from "../framework/function-unit";
import { MutableEnv } from "../framework/mutable-env";
import { isCapture, isLocal, type SlotLookup } from "../framework/slot-table";
import type { ProgramTopology } from "../framework/topology";
import { typeAnalysis } from "../type-analysis/analysis";
import { BOOL_BIT, BoolRef } from "../type-analysis/lattice";
import {
  absJoin,
  absLeq,
  BOTTOM,
  GLOBAL,
  IMPURE_MARKER,
  IMPURE_SENTINEL_NODE_ID,
  UNKNOWN,
  type AbsVal,
} from "./lattice";

// Deterministic, no I/O, don't capture or mutate args. __memo_* keep rewritten
// bodies pure.
const WHITELISTED_BUILTINS: ReadonlySet<string> = new Set([
  "range", "len", "abs", "min", "max", "int", "float", "str", "bool", "round",
  "__memo_has", "__memo_get", "__memo_put",
]);

class BlockState {
  impure = false;
  env!: MutableEnv<AbsVal>;
  slotLookup!: SlotLookup;
  selfName: string | undefined;
  chain!: Speculation;

  reset(
    env: MutableEnv<AbsVal>,
    slotLookup: SlotLookup,
    selfName: string | undefined,
    chain: Speculation,
  ): this {
    this.impure = false;
    this.env = env;
    this.slotLookup = slotLookup;
    this.selfName = selfName;
    this.chain = chain;
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
    // Closure capture: a dependency on enclosing locals, not a side effect.
    // We don't plumb cross-frame env lookup, so widen to Unknown.
    if (isCapture(info)) return UNKNOWN;
    this.state.impure = true;
    return GLOBAL;
  }

  visitGroupingExpr(expr: ExprNS.Grouping): AbsVal {
    return expr.expression.accept(this);
  }

  visitBinaryExpr(expr: ExprNS.Binary): AbsVal {
    expr.left.accept(this); expr.right.accept(this);
    return UNKNOWN;
  }
  visitCompareExpr(expr: ExprNS.Compare): AbsVal {
    expr.left.accept(this); expr.right.accept(this);
    return UNKNOWN;
  }
  visitBoolOpExpr(expr: ExprNS.BoolOp): AbsVal {
    expr.left.accept(this); expr.right.accept(this);
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
    expr.value.accept(this); expr.index.accept(this);
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

    const isWhitelistedBuiltin =
      calleeName !== undefined && WHITELISTED_BUILTINS.has(calleeName);
    const isSelfRecursion =
      calleeName !== undefined && calleeName === state.selfName;
    // Closure sub-state: `true` = resolved pure, `false` = resolved impure,
    // `undefined` = either not a closure call, or inner not yet analyzed.
    // Pending (not yet analyzed) defers: marking impure here would lock this
    // block's summary under monotone-join; wait for scope-analysis to refine.
    const closurePure =
      calleeAbs?.kind === "closure" ? calleeAbs.pure : undefined;
    const isPureClosureCall = closurePure === true;
    const isPendingClosureCall =
      calleeAbs?.kind === "closure" && closurePure === undefined;

    if (closurePure === false) {
      state.impure = true;
    } else if (
      calleeName !== undefined &&
      !isWhitelistedBuiltin &&
      !isSelfRecursion &&
      !isPureClosureCall &&
      !isPendingClosureCall
    ) {
      state.impure = true;
    }

    // Self-recursion is NOT exempt from arg escape: without an interprocedural
    // summary the callee could mutate its params, so a Fresh alias passed to
    // self must widen post-call. Rare; tighten with a summary if it bites.
    const argsEscape = !isWhitelistedBuiltin && !isPureClosureCall && !isPendingClosureCall;
    for (const arg of expr.args) {
      arg.accept(this);
      if (argsEscape && arg instanceof ExprNS.Variable) {
        const info = state.slotLookup(arg.name);
        if (isLocal(info) && state.env.get(info.slot)?.kind !== "unknown") {
          state.env.set(info.slot, UNKNOWN);
        }
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
      // Deepest verdict wins: speculative narrowings that prune impure
      // branches live at deeper contexts. `undefined` = not yet analyzed;
      // record a pending Closure so call sites defer (monotone-safe) until
      // the scope→block reads-edge wakes this block with a definite verdict.
      const innerPure = purityScopeAnalysis.readDeepest(state.chain, fd.id)?.value;
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

// No natural meet/top for AbsVal: MutableEnv uses slot absence as ⊥ and the
// DfaConfig discriminated union rejects pairing this with `mergeKind: "must"`,
// so those fields stay honestly absent. `bottom` stays as the structural
// minimum in case any consumer reads a missing cell through this lattice.
const absValLattice: JoinSemiLattice<AbsVal> = {
  bottom: BOTTOM,
  leq: absLeq,
  join: absJoin,
  eq: (a, b) => a === b || (absLeq(a, b) && absLeq(b, a)),
};

const EMPTY_EXPR_FACTS: ReadonlyMap<number, AbsVal> = new Map();

/** Pooled visitor+state. Re-entrancy-safe for the same reason as the
 *  type-analysis singleton: transferBlock is synchronous and no subscriber
 *  path re-enters purity's transfer before the call returns. */
const POOLED_PURITY_VISITOR = new PurityExprVisitor();

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
      ctx.currentContext,
    );
    for (const stmt of block.stmts) transferStmt(stmt, state, POOLED_PURITY_VISITOR);
    const exprFacts = state.impure
      ? new Map<number, AbsVal>([[IMPURE_SENTINEL_NODE_ID, IMPURE_MARKER]])
      : EMPTY_EXPR_FACTS;
    return { outEnv: state.env, exprFacts };
  },
  refineOnEdge: (env, _edge) => env,
});

// Ordering: undefined ⊏ true ⊏ false. `false` (seen-and-impure) sits at ⊤ so
// memoization's strict `=== true` gate treats both `false` and `undefined`
// as non-firing. Never expected to race; join is defensive.
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

export const purityScopeAnalysis: SemanticAnalysis<number, boolean | undefined> = defineAnalysis({
  storeAlgebra: outerLattice,
  polarity: "may",
  tier: "analysis",
  transfer(ctx: AnalysisCtx, functionId: number): boolean | undefined {
    const unit = ctx.topology.unitOfFunctionId(functionId);
    if (unit === undefined) return undefined;
    const fd = unit.funcAst;
    if (!(fd instanceof StmtNS.FunctionDef)) return undefined;
    // Reachability is per-context: a block whose only entry edge is a branch
    // condition const-false under `ctx.currentContext` is dead and its impure
    // sentinel must not poison the verdict. Without this, Collatz's
    // `print("no collatz")` joins IMPURE under `x : pos-int`.
    const reachable = reachableBlocks(unit, ctx.topology, ctx.currentContext);
    let anyVisited = false;
    for (const block of unit.cfg.blocks) {
      if (!reachable.has(block)) continue;
      const reading = purityBlockAnalysis.facts.readDeepest(ctx.currentContext, block);
      if (reading === undefined) continue;
      anyVisited = true;
      if (reading.value.has(IMPURE_SENTINEL_NODE_ID)) return false;
    }
    return anyVisited ? true : undefined;
  },
  bind(wl) {
    const fdIdOf = (unit: Unit): number[] => {
      const fd = unit.funcAst;
      return fd instanceof StmtNS.FunctionDef ? [fd.id] : [];
    };
    // Subscribe to `.facts` only — `.env` changes don't move the sentinel.
    wl.onFactDirty(purityBlockAnalysis.facts, purityScopeAnalysis, (_ctx, key) => {
      const fd = (key as BasicBlock).unit.funcAst;
      return fd instanceof StmtNS.FunctionDef ? [fd.id] : [];
    });
    wl.onMint(purityScopeAnalysis, (_ctx, unit) => fdIdOf(unit));
    wl.onRebuildDirty(purityScopeAnalysis, (_ctx, unit) => fdIdOf(unit));
    wl.onSpecRev(purityScopeAnalysis, (_ctx, unit) => fdIdOf(unit));
  },
});

function reachableBlocks(
  unit: Unit,
  topology: ProgramTopology,
  context: Speculation,
): Set<BasicBlock> {
  const reached = new Set<BasicBlock>();
  const queue: BasicBlock[] = [unit.cfg.entry];
  reached.add(unit.cfg.entry);
  // Head cursor instead of `queue.shift()` — shift() is O(n) in V8 and
  // degrades BFS to O(n²) for large CFGs.
  let head = 0;
  while (head < queue.length) {
    const block = queue[head++];
    for (const edge of block.successorEdges) {
      if (edgeIsDead(edge, topology, context)) continue;
      if (!reached.has(edge.to)) {
        reached.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return reached;
}

function edgeIsDead(
  edge: CFGEdge,
  topology: ProgramTopology,
  context: Speculation,
): boolean {
  if (edge.kind === "unconditional") return false;
  const truth = conditionTruth(edge.condition.id, topology, context);
  if (truth === undefined) return false;
  return edge.kind === "branch-true" ? truth === false : truth === true;
}

// constAnalysis covers `if True:` literals; typeAnalysis covers predicates
// like `x <= 0` that fold to BOOL_FALSE under a sign-narrowed param.
// Surfaces must agree or be absent; disagreement stays conservative.
function conditionTruth(
  nodeId: number,
  topology: ProgramTopology,
  context: Speculation,
): boolean | undefined {
  const cReading = constAnalysis.perExpr(topology).readDeepest(context, nodeId);
  if (cReading !== undefined && cReading.value.tag === "const" && typeof cReading.value.value === "boolean") {
    return cReading.value.value;
  }
  const tReading = typeAnalysis.perExpr(topology).readDeepest(context, nodeId);
  if (tReading !== undefined && tReading.value.kinds === BOOL_BIT) {
    if (tReading.value.boolRef === BoolRef.True) return true;
    if (tReading.value.boolRef === BoolRef.False) return false;
  }
  return undefined;
}

// Scope→block: outer block's FunctionDef transfer reads purityScopeAnalysis
// for nested fd verdicts. Project the fd.id write to the outer block via
// `topology.blockOfNode`. Mutual reference — installed at bind time.
//
// SpecRev re-seed: repopulates block facts under the new speculative context
// so scope transfer can read them there instead of falling back to ROOT.
purityBlockAnalysis.env.bind = composeBind(purityBlockAnalysis.env.bind, (wl) => {
  wl.onFactDirty(purityScopeAnalysis, purityBlockAnalysis.env, (ctx, key) => {
    if (typeof key !== "number") return [];
    const block = ctx.topology.blockOfNode(key);
    return block === undefined ? [] : [block];
  });
  wl.onSpecRev(purityBlockAnalysis.env, (_ctx, unit) => [purityBlockAnalysis.seed(unit)]);
});
