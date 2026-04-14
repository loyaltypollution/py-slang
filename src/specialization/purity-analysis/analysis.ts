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
import type { Lattice, Pass, PassCtx, ReadSpec } from "../framework/pass";
import { isCapture, isLocal, type SlotLookup } from "../framework/slot-table";
import { structuralPass } from "../framework/structural-pass";
import {
  absEquals,
  absJoin,
  absLeq,
  closure,
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
    readonly ctx: PassCtx,
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
    if (isCapture(info)) {
      // Closure capture of an enclosing function's local. A dependency, not
      // a side effect — the purity of a closure is "deterministic in its
      // inputs including captures," so reading a capture on its own does
      // not disqualify. We lose the outer's abstract value without plumbing
      // cross-frame env lookup, so return Unknown.
      return UNKNOWN;
    }
    // Built-in or module-level global: can change between calls, impure.
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
  let calleeAbs: AbsVal | undefined;
  if (expr.callee instanceof ExprNS.Variable) {
    calleeName = expr.callee.name.lexeme;
    const info = state.slotLookup(expr.callee.name);
    if (isLocal(info)) calleeAbs = state.env.get(info.slot);
  } else {
    // Computed callee (e.g. subscript of list-of-fns) is not analyzable.
    transferExpr(expr.callee, state);
    state.markImpure();
  }

  const isWhitelistedBuiltin =
    calleeName !== undefined && WHITELISTED_BUILTINS.has(calleeName);
  const isSelfRecursion =
    calleeName !== undefined && calleeName === state.selfName;
  const isClosureCall = calleeAbs !== undefined && calleeAbs.kind === "closure";
  const isPureClosureCall =
    isClosureCall && (calleeAbs as { pure: boolean | undefined }).pure === true;
  const isImpureClosureCall =
    isClosureCall && (calleeAbs as { pure: boolean | undefined }).pure === false;
  // Pending closure: inner purity not yet determined. Defer judgment —
  // marking impure here would lock this block's summary under the
  // monotone-join fact-store, blocking a later refinement to "pure."
  const isPendingClosureCall =
    isClosureCall && (calleeAbs as { pure: boolean | undefined }).pure === undefined;

  if (isImpureClosureCall) {
    state.markImpure();
  } else if (
    !isWhitelistedBuiltin &&
    !isSelfRecursion &&
    !isPureClosureCall &&
    !isPendingClosureCall &&
    calleeName !== undefined
  ) {
    // Unknown function: effects are unconstrained.
    state.markImpure();
  }

  // Evaluate args for their own effects, and escape any Variable-shaped args
  // to Unknown unless the callee is a read-only whitelisted builtin or a
  // statically-known pure or pending closure.
  const argsEscape = !isWhitelistedBuiltin && !isPureClosureCall && !isPendingClosureCall;
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
      if (r.value !== null) {
        const val = transferExpr(r.value, state);
        // Returning a resolved-impure closure escapes it to the caller, who
        // may invoke it and observe side effects. Taint the enclosing fn.
        // Pending closures (inner purity undetermined) defer judgment.
        if (val.kind === "closure" && val.pure === false) state.markImpure();
      }
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

    case "FunctionDef": {
      // Nested FunctionDef is its own FunctionUnit with its own purity
      // analysis. Bind the name's slot to a Closure value carrying the
      // inner's purity verdict. Creating a closure is *not* itself a side
      // effect — only calling or escaping an impure one is.
      const fd = stmt as StmtNS.FunctionDef;
      const info = state.slotLookup(fd.name);
      if (!isLocal(info)) {
        state.markImpure();
        return;
      }
      const innerPure = state.ctx.tryRead(purityScopePass, fd.id);
      // Defer on `undefined`: the inner hasn't been analyzed yet — record a
      // *pending* Closure. Call sites and escape points treat pending as
      // "deferred" (no markImpure), keeping this block's summary monotone
      // under the cross-pass dependency. When the inner converges, the
      // reads-edge `purityBlockPass ← purityScopePass` wakes this block
      // and the binding resolves to a definite true/false verdict.
      state.env.set(info.slot, closure(fd.id, innerPure));
      return;
    }

    case "Global":
    case "NonLocal":
    case "FromImport":
      // Naming a nonlocal/global binding rebinds across scope — observable.
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
  transferBlock: (ctx, block, inEnv, unit) => {
    const state = new BlockState(inEnv, unit.slotLookup, selfNameOf(unit), ctx);
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
  reads: [
    {
      pass: structuralPass,
      project: (_ctx, key) => {
        const fd = (key as FunctionUnit).funcAst;
        return fd instanceof StmtNS.FunctionDef ? [fd.id] : [];
      },
    },
    {
      pass: purityBlockPass,
      project: (_ctx, key) => {
        const fd = (key as BasicBlock).unit.funcAst;
        return fd instanceof StmtNS.FunctionDef ? [fd.id] : [];
      },
    },
  ],
  tier: "analysis",
  coarse: false,
  transfer(ctx: PassCtx, fdId: number): boolean | undefined {
    const unit = ctx.unitForFdId(fdId);
    if (unit === undefined) return undefined;
    const fd = unit.funcAst;
    if (!(fd instanceof StmtNS.FunctionDef)) return undefined;
    // Purity is a whole-function property: "does any reachable block have a
    // local impure effect?" The block DFA only writes facts for reachable
    // blocks (worklist walks CFG successors from entry), so OR'ing the
    // summaries of all visited blocks is the right aggregation. If no block
    // has been visited yet, defer until the inner pass has run.
    let anyVisited = false;
    for (const block of unit.cfg.blocks) {
      const fact = ctx.tryRead(purityBlockPass, block);
      if (fact === undefined) continue;
      anyVisited = true;
      if (fact.summary.impure) return false;
    }
    return anyVisited ? true : undefined;
  },
};

// Cross-pass reads: the block pass consults `purityScopePass` when it hits a
// nested `FunctionDef` stmt (to learn the nested function's purity verdict).
// Declared post-hoc because both passes reference each other. The factory
// returns `reads` as a plain (unfrozen) array so late amendments are safe.
// Wake-up path: when the nested fd's scope-pass writes for `fdId`, project
// to the outer block containing that `def` stmt via `unitForNode` +
// `blockOfNode`.
const scopeToBlock: ReadSpec<BasicBlock> = {
  pass: purityScopePass,
  project: (ctx, key) => {
    if (typeof key !== "number") return [];
    const u = ctx.unitForNode(key);
    const block = u?.blockOfNode.get(key);
    return block === undefined ? [] : [block];
  },
};
(purityBlockPass.reads as ReadSpec<BasicBlock>[]).push(scopeToBlock);
