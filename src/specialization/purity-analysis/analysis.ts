// Intraprocedural purity analysis with freshness/escape tracking.
//
// Inner pass: block-keyed DFA (registered via the DFA factory). Per-slot
// abstract value tracks the *origin* of each local binding (Fresh/Param/Global/
// Unknown). A block-global sticky `impure` summary captures effects that can't
// be attributed to a slot (assert, global writes, non-whitelisted calls, etc.).
//
// Outer pass: `purityScopePass`, keyed by `FunctionDef.id`, projects the exit
// block's summary to `true | false | undefined` for the memoization consumer.
//
// Freshness earns the CFG dataflow: `xs = []; xs[0] = 1` stays pure because
// `xs` holds a `Fresh` value at the subscript-store. At merge points,
// `xs = [] / xs = param` joins to `Unknown`, so subsequent mutation widens to
// impure — flow-sensitivity that a linear scan can't express.
//
// Lambda / MultiLambda / nested FunctionDef currently stay sticky-impure; a
// later phase will consume nested `purityScopePass` results for proper closure
// analysis.
//
// Consumer: `memoizationRule`.

import { ExprNS, StmtNS } from "../../ast-types";
import type { BasicBlock } from "../framework/cfg";
import {
  makeBlockFixpointPass,
  type DfaBlockFact,
} from "../framework/dfa-factory";
import type { FunctionUnit } from "../framework/function-unit";
import { MutableEnv } from "../framework/mutable-env";
import type { Lattice, Pass, PassCtx } from "../framework/pass";
import { isLocal, type SlotLookup } from "../framework/slot-table";
import { structuralPass } from "../framework/structural-pass";
import {
  absEquals,
  absJoin,
  absLeq,
  fresh,
  GLOBAL,
  param,
  PURE_SUMMARY,
  IMPURE_SUMMARY,
  summaryEquals,
  summaryJoin,
  UNKNOWN,
  type AbsVal,
  type PurityBlockSummary,
} from "./lattice";

// Memo-safe builtins (deterministic, no I/O, don't capture or mutate args).
// __memo_* keep rewritten bodies pure.
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

// Mutable state threaded through the block transfer: the OUT env and a sticky
// impure flag. A single mutable holder lets the expression walker downgrade
// slots at escape points without plumbing extra return channels.
class BlockState {
  impure = false;
  constructor(
    readonly env: MutableEnv<AbsVal>,
    readonly slotLookup: SlotLookup,
    readonly selfName: string | undefined,
  ) {}

  markImpure(): void {
    this.impure = true;
  }

  /** Escape a local slot to `Unknown` (e.g., passed to a non-whitelisted call). */
  escapeSlot(slot: number): void {
    const cur = this.env.get(slot);
    if (cur === undefined || cur.kind !== "unknown") {
      this.env.set(slot, UNKNOWN);
    }
  }
}

function transferExpr(expr: ExprNS.Expr, state: BlockState): AbsVal {
  if (
    expr instanceof ExprNS.Literal ||
    expr instanceof ExprNS.BigIntLiteral ||
    expr instanceof ExprNS.Complex ||
    expr instanceof ExprNS.None
  ) {
    return UNKNOWN;
  }

  if (expr instanceof ExprNS.Variable) {
    const info = state.slotLookup(expr.name);
    if (isLocal(info)) {
      return state.env.get(info.slot) ?? UNKNOWN;
    }
    // Nonlocal / global read: value depends on outside state.
    state.markImpure();
    return GLOBAL;
  }

  if (expr instanceof ExprNS.Grouping) {
    return transferExpr(expr.expression, state);
  }

  if (
    expr instanceof ExprNS.Binary ||
    expr instanceof ExprNS.Compare ||
    expr instanceof ExprNS.BoolOp
  ) {
    transferExpr(expr.left, state);
    transferExpr(expr.right, state);
    return UNKNOWN;
  }

  if (expr instanceof ExprNS.Unary) {
    transferExpr(expr.right, state);
    return UNKNOWN;
  }

  if (expr instanceof ExprNS.Ternary) {
    transferExpr(expr.predicate, state);
    transferExpr(expr.consequent, state);
    transferExpr(expr.alternative, state);
    return UNKNOWN;
  }

  if (expr instanceof ExprNS.Subscript) {
    transferExpr(expr.value, state);
    transferExpr(expr.index, state);
    return UNKNOWN;
  }

  if (expr instanceof ExprNS.List) {
    for (const el of expr.elements) transferExpr(el, state);
    return fresh(expr.id);
  }

  if (expr instanceof ExprNS.Call) {
    return transferCall(expr, state);
  }

  if (expr instanceof ExprNS.Lambda || expr instanceof ExprNS.MultiLambda) {
    // Deferred: proper closure analysis in a later phase.
    state.markImpure();
    return UNKNOWN;
  }

  if (expr instanceof ExprNS.Starred) {
    transferExpr(expr.value, state);
    state.markImpure();
    return UNKNOWN;
  }

  state.markImpure();
  return UNKNOWN;
}

function transferCall(expr: ExprNS.Call, state: BlockState): AbsVal {
  let calleeName: string | undefined;
  if (expr.callee instanceof ExprNS.Variable) {
    calleeName = expr.callee.name.lexeme;
  } else {
    // Computed callee (e.g. subscript of list-of-fns) is not analyzable.
    transferExpr(expr.callee, state);
    state.markImpure();
  }

  const isWhitelistedBuiltin =
    calleeName !== undefined && WHITELISTED_BUILTINS.has(calleeName);
  const isSelfRecursion =
    calleeName !== undefined && calleeName === state.selfName;

  if (!isWhitelistedBuiltin && !isSelfRecursion && calleeName !== undefined) {
    // Unknown function: effects are unconstrained.
    state.markImpure();
  }

  // Evaluate args for their own effects, and escape any Variable-shaped args
  // to Unknown unless the callee is a read-only whitelisted builtin.
  const argsEscape = !isWhitelistedBuiltin;
  for (const arg of expr.args) {
    transferExpr(arg, state);
    if (argsEscape && arg instanceof ExprNS.Variable) {
      const info = state.slotLookup(arg.name);
      if (isLocal(info)) state.escapeSlot(info.slot);
    }
  }
  return UNKNOWN;
}

function transferStmt(stmt: StmtNS.Stmt, state: BlockState): void {
  switch (stmt.kind) {
    case "Pass":
    case "Break":
    case "Continue":
    case "FileInput":
      return;

    case "Return": {
      const r = stmt as StmtNS.Return;
      if (r.value !== null) transferExpr(r.value, state);
      return;
    }

    case "Assign": {
      const a = stmt as StmtNS.Assign;
      const val = transferExpr(a.value, state);
      if (a.target instanceof ExprNS.Variable) {
        const info = state.slotLookup(a.target.name);
        if (isLocal(info)) {
          state.env.set(info.slot, val);
        } else {
          state.markImpure(); // Write to nonlocal/global is observable.
        }
        return;
      }
      // Subscript-store: pure iff the container is Fresh in this frame.
      const container = transferExpr(a.target.value, state);
      transferExpr(a.target.index, state);
      if (container.kind !== "fresh") {
        state.markImpure();
      }
      return;
    }

    case "AnnAssign": {
      const a = stmt as StmtNS.AnnAssign;
      const val = transferExpr(a.value, state);
      const info = state.slotLookup(a.target.name);
      if (isLocal(info)) {
        state.env.set(info.slot, val);
      } else {
        state.markImpure();
      }
      return;
    }

    case "If":
      transferExpr((stmt as StmtNS.If).condition, state);
      return;
    case "While":
      transferExpr((stmt as StmtNS.While).condition, state);
      return;

    case "For": {
      const fs = stmt as StmtNS.For;
      transferExpr(fs.iter, state);
      const info = state.slotLookup(fs.target);
      if (isLocal(info)) {
        state.env.set(info.slot, UNKNOWN);
      } else {
        state.markImpure();
      }
      return;
    }

    case "SimpleExpr":
      // Recurse into the expression; its effects (or lack thereof) stand.
      transferExpr((stmt as StmtNS.SimpleExpr).expression, state);
      return;

    case "Assert": {
      transferExpr((stmt as StmtNS.Assert).value, state);
      state.markImpure(); // Assert can raise; control-flow observable.
      return;
    }

    case "FunctionDef":
    case "Global":
    case "NonLocal":
    case "FromImport":
      // Deferred (closure analysis) or outright disqualifying.
      state.markImpure();
      return;
  }
}

function selfNameOf(unit: FunctionUnit): string | undefined {
  const fd = unit.funcAst;
  return fd instanceof StmtNS.FunctionDef ? fd.name.lexeme : undefined;
}

function seedEnv(unit: FunctionUnit): MutableEnv<AbsVal> {
  const env = new MutableEnv<AbsVal>();
  const fd = unit.funcAst;
  if (fd instanceof StmtNS.FunctionDef) {
    for (let i = 0; i < fd.parameters.length; i++) {
      env.set(i, param(i));
    }
  }
  return env;
}

const absValLattice: Pick<Lattice<AbsVal>, "equals"> & {
  leq: (a: AbsVal, b: AbsVal) => boolean;
  join: (a: AbsVal, b: AbsVal) => AbsVal;
} = {
  equals: absEquals,
  leq: absLeq,
  join: absJoin,
};

const summaryLattice: Lattice<PurityBlockSummary> = {
  bottom: PURE_SUMMARY,
  equals: summaryEquals,
  join: summaryJoin,
};

export const purityBlockPass: Pass<
  BasicBlock,
  DfaBlockFact<AbsVal, PurityBlockSummary>
> = makeBlockFixpointPass<AbsVal, PurityBlockSummary>({
  debugName: "purityAnalysis",
  direction: "forward",
  top: UNKNOWN,
  leq: absValLattice.leq,
  join: absValLattice.join,
  // `meet` is unused for "may"-merge; provide absJoin to satisfy the config.
  meet: absValLattice.join,
  mergeKind: "may",
  summaryLattice,
  reads: [],
  seedEnv,
  transferBlock: (_ctx, block, inEnv, unit) => {
    const state = new BlockState(inEnv, unit.slotLookup, selfNameOf(unit));
    for (const stmt of block.stmts) transferStmt(stmt, state);
    return {
      outEnv: state.env,
      exprFacts: EMPTY_EXPR_FACTS,
      summary: state.impure ? IMPURE_SUMMARY : PURE_SUMMARY,
    };
  },
});

const EMPTY_EXPR_FACTS: ReadonlyMap<number, AbsVal> = new Map();

// Outer projection: FunctionDef.id → boolean | undefined.
// `undefined` means "not yet analyzed" (no exit fact written). Memoization
// only fires on strict `=== true`, so both `false` and `undefined` gate it off.
const outerLattice: Lattice<boolean | undefined> = {
  bottom: undefined,
  equals: (a, b) => a === b,
  // Never expected to race: single writer per fd.id. Join is defensive.
  join: (a, b) => {
    if (a === undefined) return b;
    if (b === undefined) return a;
    return a && b;
  },
};

export const purityScopePass: Pass<number, boolean | undefined> = {
  id: Symbol("purityScopePass"),
  debugName: "purityScopePass",
  lattice: outerLattice,
  reads: [purityBlockPass, structuralPass],
  tier: "analysis",
  coarse: false,
  affectedKeys(_ctx, triggerPass, triggerKey) {
    if (triggerPass === (structuralPass as Pass<any, any>)) {
      const fd = (triggerKey as FunctionUnit).funcAst;
      if (fd instanceof StmtNS.FunctionDef) return [fd.id];
      return [];
    }
    if (triggerPass === (purityBlockPass as Pass<any, any>)) {
      const block = triggerKey as BasicBlock;
      const fd = block.unit.funcAst;
      if (fd instanceof StmtNS.FunctionDef) return [fd.id];
    }
    return [];
  },
  transfer(ctx: PassCtx, fdId: number): boolean | undefined {
    const unit = ctx.unitForFdId(fdId);
    if (unit === undefined) return undefined;
    const fd = unit.funcAst;
    if (!(fd instanceof StmtNS.FunctionDef)) return undefined;
    const exitFact = ctx.tryRead(purityBlockPass, unit.cfg.exit);
    if (exitFact === undefined) return undefined;
    return !exitFact.summary.impure;
  },
};
