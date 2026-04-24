// Intraprocedural purity analysis. Axes the block transfer decomposes over:
//   - arithmetic / local assignment   — pure by default.
//   - whitelisted builtins            — `range`, `len`, … stay pure despite
//                                       being calls.
//   - subscript read vs store         — read is pure; store is impure unless
//                                       the target is a fresh (locally-
//                                       allocated, non-escaped) container.
//   - nested FunctionDef              — analyzed as its own Unit and read
//                                       back via `purityScopeAnalysis`.
//                                       Lambda / MultiLambda: sticky-impure.
//   - speculation composition         — branches pruned by a chain's param
//                                       narrowings drop their impurity
//                                       contributors at the specialized
//                                       context.
//   - capture reads                   — a nested fn reading an outer local
//                                       is a dependency, not an effect.

import { ExprNS, StmtNS } from "../../../ast-types";
import { constAnalysis } from "../const/analysis";
import type {
  Analysis,
  AnalysisCtx,
  JoinSemiLattice,
} from "../../framework/analysis";
import { composeBind, defineAnalysis } from "../../framework/analysis";
import type { BasicBlock } from "../../framework/cfg";
import { type AssumptionChain } from "../../assumption/chain";
import {
  makeBlockFixpointAnalysis,
  type BlockFixpointAnalysis,
} from "../../framework/dfa-factory";
import type { Unit } from "../../framework/function-unit";
import { MutableEnv } from "../../framework/mutable-env";
import { isCapture, isLocal, type SlotLookup } from "../../framework/slot-table";
import type { ProgramTopology } from "../../framework/topology";
import { typeAnalysis } from "../type/analysis";
import { BOOL_BIT, BoolRef } from "../type/lattice";
import {
  absValLattice,
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
  chain!: AssumptionChain;

  reset(
    env: MutableEnv<AbsVal>,
    slotLookup: SlotLookup,
    selfName: string | undefined,
    chain: AssumptionChain,
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

    // Closure.pure: true = resolved pure, false = resolved impure, undefined =
    // not a closure call OR inner not yet analyzed (pending defers impurity
    // to stay monotone).
    const closurePure =
      calleeAbs?.kind === "closure" ? calleeAbs.pure : undefined;
    const isClosureCallee = calleeAbs?.kind === "closure";
    const isPureClosureCall = isClosureCallee && closurePure === true;
    const isPendingClosureCall = isClosureCallee && closurePure === undefined;
    const isImpureClosureCall = isClosureCallee && closurePure === false;
    const isWhitelistedBuiltin =
      calleeName !== undefined && WHITELISTED_BUILTINS.has(calleeName);
    const isSelfRecursion = calleeName !== undefined && calleeName === state.selfName;
    // A named call is assumed impure unless it's a builtin, self-recursion, or
    // a closure we've either resolved-pure or not yet analyzed (pending is
    // monotone-deferred). An indirect callee already tainted `impure` above.
    const isKnownSafeNamedCall =
      isWhitelistedBuiltin || isSelfRecursion || isPureClosureCall || isPendingClosureCall;

    if (isImpureClosureCall || (calleeName !== undefined && !isKnownSafeNamedCall)) {
      state.impure = true;
    }

    // Self-recursion is NOT exempt from arg escape: without an interprocedural
    // summary the callee could mutate its params, so a Fresh alias passed to
    // self must widen post-call.
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
      // Deepest verdict wins; `undefined` = pending until the scope→block
      // reads-edge wakes this block with a definite verdict.
      const innerPure = purityScopeAnalysis.store.readDeepest(state.chain, fd.id)?.value;
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

export const purityScopeAnalysis: Analysis<number, boolean | undefined> = defineAnalysis({
  storeAlgebra: outerLattice,
  polarity: "may",
  tier: "analysis",
  transfer(ctx: AnalysisCtx, functionId: number): boolean | undefined {
    const unit = ctx.units.get(functionId);
    if (unit === undefined) return undefined;
    const fd = unit.funcAst;
    if (!(fd instanceof StmtNS.FunctionDef)) return undefined;
    // Per-context reachability: a block reached only via a const-dead edge
    // under `ctx.currentContext` must not contribute its impure sentinel
    // (e.g. Collatz joining IMPURE under `x : pos-int`).
    const reachable = reachableBlocks(unit, ctx.topology, ctx.currentContext);
    let anyVisited = false;
    for (const block of unit.cfg.blocks) {
      if (!reachable.has(block)) continue;
      const reading = purityBlockAnalysis.facts.store.readDeepest(ctx.currentContext, block);
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
  context: AssumptionChain,
): Set<BasicBlock> {
  const reached = new Set<BasicBlock>([unit.cfg.entry]);
  const queue: BasicBlock[] = [unit.cfg.entry];
  // Head cursor (O(1) amortized) vs shift() which is O(n) in V8.
  let head = 0;
  while (head < queue.length) {
    const block = queue[head++];
    for (const edge of block.successorEdges) {
      if (edge.kind !== "unconditional") {
        const truth = conditionTruth(edge.condition.id, topology, context);
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

// constAnalysis covers `if True:` literals; typeAnalysis covers predicates
// like `x <= 0` that fold to BOOL_FALSE under a sign-narrowed param.
// Surfaces must agree or be absent; disagreement stays conservative.
function conditionTruth(
  nodeId: number,
  topology: ProgramTopology,
  context: AssumptionChain,
): boolean | undefined {
  const cVal = constAnalysis.perExpr(topology).readDeepest(context, nodeId)?.value;
  if (cVal?.tag === "const" && typeof cVal.value === "boolean") return cVal.value;
  const tVal = typeAnalysis.perExpr(topology).readDeepest(context, nodeId)?.value;
  if (tVal?.kinds === BOOL_BIT) {
    if (tVal.boolRef === BoolRef.True) return true;
    if (tVal.boolRef === BoolRef.False) return false;
  }
  return undefined;
}

// Scope→block mutual dependency installed at bind time: outer block's
// FunctionDef transfer reads purityScopeAnalysis for nested fd verdicts; the
// fd.id write is projected to the outer block via `topology.blockOfNode`.
// SpecRev re-seeds block facts under the new speculative context.
purityBlockAnalysis.env.bind = composeBind(purityBlockAnalysis.env.bind, (wl) => {
  wl.onFactDirty(purityScopeAnalysis, purityBlockAnalysis.env, (ctx, key) => {
    if (typeof key !== "number") return [];
    const block = ctx.unitOfNode(key)?.blockOfNode(key);
    return block === undefined ? [] : [block];
  });
  wl.onSpecRev(purityBlockAnalysis.env, (_ctx, unit) => [purityBlockAnalysis.seed(unit)]);
});
