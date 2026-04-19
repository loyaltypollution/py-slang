// Intraprocedural purity analysis with freshness/escape tracking.
//
// Freshness earns the CFG dataflow: `xs = []; xs[0] = 1` stays pure because
// `xs` holds a `Fresh` value at the subscript-store. At merge points,
// `xs = [] / xs = param` joins to `Unknown`, so subsequent mutation widens to
// impure — flow-sensitivity a linear scan can't express.
//
// Nested `FunctionDef` bodies are analyzed as their own `Unit`s; the
// enclosing block reads the nested `purityScopeAnalysis` verdict via a cross-analysis
// reads-edge and binds the name's slot to `Closure(functionId, pure)`. Pending
// closures (inner not yet analyzed) defer judgment until the scope-analysis
// refinement arrives.
//
// `Lambda` / `MultiLambda` stay sticky-impure — out of scope for this phase.

import { ExprNS, StmtNS } from "../../ast-types";
import type { BasicBlock } from "../framework/cfg";
import {
  makeBlockFixpointAnalysis,
  type BlockFixpointAnalysis,
} from "../framework/dfa-factory";
import type { Unit } from "../framework/function-unit";
import { MutableEnv } from "../framework/mutable-env";
import type {
  EdgeSpec,
  JoinSemiLattice,
  Analysis,
  AnalysisCtx,
  SemanticAnalysis,
} from "../framework/analysis";
import { addEdge, defineAnalysis } from "../framework/analysis";
import { storeEvict } from "../framework/analysis-store";
import { ROOT_CONTEXT } from "../framework/context";
import { isCapture, isLocal, type SlotLookup } from "../framework/slot-table";
import {
  absJoin,
  absLeq,
  GLOBAL,
  IMPURE_MARKER,
  IMPURE_SENTINEL_NODE_ID,
  BOTTOM,
  UNKNOWN,
  type AbsVal,
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

// Why a bespoke transfer instead of `framework/block-transfer.ts` +
// `makeExprVisitor`:
//
//   1. Side-effect channel — we thread a mutable `impure` bit; const/type
//      lattices have no orthogonal summary state.
//   2. Subscript-store semantics — purity must inspect the target's abstract
//      value (Fresh vs. not) and evaluate `target.value`/`target.index`.
//      `block-transfer.ts` returns early on non-Variable assign targets.
//   3. Capture distinction — reading a capture is a dependency (returns
//      Unknown, no taint); reading a plain nonlocal is impure. Const/type
//      collapse both to top.
//   4. `FunctionDef` stmt — binds a Closure value via cross-analysis read of
//      `purityScopeAnalysis`. Const/type treat FunctionDef as a no-op.
//   5. Call-site arg escape — bare Variable args to unknown callees get
//      downgraded to Unknown in the env. Const/type don't model escape.
//
// Any of these would break the existing const/type analyses if retrofitted
// into the shared block-transfer. The visitor-pattern style (vs. the
// instanceof chain used here) is a stylistic drift — not semantic — and
// could be unified if a new Expr kind surfaces missed-case risk.
//
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
    state.impure = true;
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
    return { kind: "fresh", origin: expr.id };
  }

  if (expr instanceof ExprNS.Call) {
    return transferCall(expr, state);
  }

  if (expr instanceof ExprNS.Lambda || expr instanceof ExprNS.MultiLambda) {
    // Deferred: proper closure analysis in a later phase.
    state.impure = true;
    return UNKNOWN;
  }

  if (expr instanceof ExprNS.Starred) {
    transferExpr(expr.value, state);
    state.impure = true;
    return UNKNOWN;
  }

  state.impure = true;
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
    state.impure = true;
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
  // monotone-join store algebra, blocking a later refinement to "pure."
  const isPendingClosureCall =
    isClosureCall && (calleeAbs as { pure: boolean | undefined }).pure === undefined;

  if (isImpureClosureCall) {
    state.impure = true;
  } else if (
    !isWhitelistedBuiltin &&
    !isSelfRecursion &&
    !isPureClosureCall &&
    !isPendingClosureCall &&
    calleeName !== undefined
  ) {
    // Unknown function: effects are unconstrained.
    state.impure = true;
  }

  // Evaluate args for their own effects, and escape any Variable-shaped args
  // to Unknown unless the callee is a read-only whitelisted builtin or a
  // statically-known pure or pending closure.
  //
  // Self-recursion is NOT in the exempt set: without an interprocedural
  // summary we must assume the callee could mutate its params. Callers that
  // self-recurse with a bare Variable arg holding a Fresh value will see
  // that Fresh track destroyed post-call. Rare and appropriately
  // conservative — tighten with a summary-based analysis if it ever bites.
  const argsEscape = !isWhitelistedBuiltin && !isPureClosureCall && !isPendingClosureCall;
  for (const arg of expr.args) {
    transferExpr(arg, state);
    if (argsEscape && arg instanceof ExprNS.Variable) {
      const info = state.slotLookup(arg.name);
      // Escape a local slot to `Unknown` when it may be mutated via alias.
      if (isLocal(info) && state.env.get(info.slot)?.kind !== "unknown") {
        state.env.set(info.slot, UNKNOWN);
      }
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
        if (val.kind === "closure" && val.pure === false) state.impure = true;
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
          state.impure = true; // Write to nonlocal/global is observable.
        }
        return;
      }
      // Subscript-store: pure iff the container is Fresh in this frame.
      const container = transferExpr(a.target.value, state);
      transferExpr(a.target.index, state);
      if (container.kind !== "fresh") {
        state.impure = true;
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
        state.impure = true;
      }
      return;
    }

    // If/While bodies live in separate BasicBlocks — transferBlock here only
    // sees the branch condition; the bodies are reached via CFG successors.
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
        state.impure = true;
      }
      return;
    }

    case "SimpleExpr":
      // Recurse into the expression; its effects (or lack thereof) stand.
      transferExpr((stmt as StmtNS.SimpleExpr).expression, state);
      return;

    case "Assert": {
      transferExpr((stmt as StmtNS.Assert).value, state);
      state.impure = true; // Assert can raise; control-flow observable.
      return;
    }

    case "FunctionDef": {
      // Nested FunctionDef is its own Unit with its own purity
      // analysis. Bind the name's slot to a Closure value carrying the
      // inner's purity verdict. Creating a closure is *not* itself a side
      // effect — only calling or escaping an impure one is.
      const fd = stmt as StmtNS.FunctionDef;
      const info = state.slotLookup(fd.name);
      if (!isLocal(info)) {
        state.impure = true;
        return;
      }
      const innerPure = purityScopeAnalysis.store.tryRead(fd.id, ROOT_CONTEXT);
      // Defer on `undefined`: the inner hasn't been analyzed yet — record a
      // *pending* Closure. Call sites and escape points treat pending as
      // "deferred" (no markImpure), keeping this block's summary monotone
      // under the cross-analysis dependency. When the inner converges, the
      // reads-edge `purityBlockAnalysis ← purityScopeAnalysis` wakes this block
      // and the binding resolves to a definite true/false verdict.
      state.env.set(info.slot, { kind: "closure", functionId: fd.id, pure: innerPure });
      return;
    }

    case "Global":
    case "NonLocal":
    case "FromImport":
      // Naming a nonlocal/global binding rebinds across scope — observable.
      state.impure = true;
      return;
  }
}

// AbsVal has no natural ⊥ (slot absence in MutableEnv represents "not yet
// assigned") and no natural meet. Typed as plain `JoinSemiLattice` — the DfaConfig
// discriminated union refuses to pair this with `mergeKind: "must"`, so
// `meet`/`top` can be honestly absent rather than fabricated-and-thrown.
// `bottom` is the structural `{kind:"bottom"}` variant — the true lattice
// minimum. MutableEnv represents ⊥ as slot absence and never surfaces this
// value today, but keeping the field honest avoids a latent miscompilation
// if any consumer ever reads a missing cell through this lattice.
const absValLattice: JoinSemiLattice<AbsVal> = {
  bottom: BOTTOM,
  leq: absLeq,
  join: absJoin,
  eq: (a, b) => a === b || (absLeq(a, b) && absLeq(b, a)),
};

export const purityBlockAnalysis: BlockFixpointAnalysis<AbsVal> =
  makeBlockFixpointAnalysis<AbsVal>({
  debugName: "purityAnalysis",
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
  transferBlock: (_ctx, block, inEnv, unit) => {
    const fd = unit.funcAst;
    const selfName = fd instanceof StmtNS.FunctionDef ? fd.name.lexeme : undefined;
    const state = new BlockState(inEnv, unit.slotLookup, selfName);
    for (const stmt of block.stmts) transferStmt(stmt, state);
    // Block-global impure flag lives at a sentinel key in `exprFacts`. The
    // DFA factory's per-key lattice join handles monotone propagation; a
    // present sentinel joined with an absent one stays present (any-impure
    // semantics), two presents join to IMPURE_MARKER.
    const exprFacts = state.impure
      ? new Map<number, AbsVal>([[IMPURE_SENTINEL_NODE_ID, IMPURE_MARKER]])
      : EMPTY_EXPR_FACTS;
    return { outEnv: state.env, exprFacts };
  },
  // Purity does not narrow across predicate edges — a slot's freshness /
  // origin doesn't depend on whether `if x > 0` was true.
  refineOnEdge: (env, _edge) => env,
});

const EMPTY_EXPR_FACTS: ReadonlyMap<number, AbsVal> = new Map();

// Outer projection: FunctionDef.id → boolean | undefined.
// `undefined` means "not yet analyzed" (no exit fact written). Memoization
// only fires on strict `=== true`, so both `false` and `undefined` gate it off.
const outerLattice: JoinSemiLattice<boolean | undefined> = {
  bottom: undefined,
  // Total order: undefined ⊏ true ⊏ false. `false` (seen-and-impure) is ⊤;
  // `true` is the pure verdict; `undefined` is "unseen". Join = `a && b`
  // places `false` at the top, which matches memoization's gate (strict
  // `=== true` is required to fire, so `false` correctly poisons).
  leq: (a, b) => a === undefined || a === b || (a === true && b === false),
  // Never expected to race: single writer per fd.id. Join is defensive.
  join: (a, b) => {
    if (a === undefined) return b;
    if (b === undefined) return a;
    return a && b;
  },
  eq: (a, b) => a === b,
};

export const purityScopeAnalysis: SemanticAnalysis<number, boolean | undefined> = defineAnalysis({
  id: Symbol("purityScopeAnalysis"),
  debugName: "purityScopeAnalysis",
  keySpace: "functionId",
  storeAlgebra: outerLattice,
  polarity: "may",
  edges: [
    {
      // Subscribe to `.facts` changes — that's where `IMPURE_SENTINEL_NODE_ID`
      // lives. `.env` changes don't affect the sentinel, so waking on them
      // would fire this scope transfer for no reason.
      on: "fact",
      analysis: purityBlockAnalysis.facts,
      wake: (_ctx, key) => {
        const fd = (key as BasicBlock).unit.funcAst;
        return fd instanceof StmtNS.FunctionDef ? [fd.id] : [];
      },
    },
    {
      on: "mint",
      wake: (_ctx, unit) => {
        const fd = unit.funcAst;
        return fd instanceof StmtNS.FunctionDef ? [fd.id] : [];
      },
    },
    {
      on: "rebuild",
      wake: (_ctx, unit) => {
        const fd = unit.funcAst;
        return fd instanceof StmtNS.FunctionDef ? [fd.id] : [];
      },
    },
    {
      on: "retire",
      effect: (_ctx, unit) => {
        const fd = unit.funcAst;
        if (fd instanceof StmtNS.FunctionDef) {
          storeEvict(purityScopeAnalysis.store, fd.id, ROOT_CONTEXT);
        }
      },
    },
  ],
  tier: "analysis",
  transfer(ctx: AnalysisCtx, functionId: number): boolean | undefined {
    const unit = ctx.topology.unitOfFunctionId(functionId);
    if (unit === undefined) return undefined;
    const fd = unit.funcAst;
    if (!(fd instanceof StmtNS.FunctionDef)) return undefined;
    // Purity is a whole-function property: "does any reachable block have a
    // local impure effect?" The block DFA only writes facts for reachable
    // blocks (worklist walks CFG successors from entry), so OR'ing the
    // summaries of all visited blocks is the right aggregation. If no block
    // has been visited yet, defer until the inner analysis has run.
    let anyVisited = false;
    for (const block of unit.cfg.blocks) {
      const facts = purityBlockAnalysis.facts.store.tryRead(block, ROOT_CONTEXT);
      if (facts === undefined) continue;
      anyVisited = true;
      if (facts.has(IMPURE_SENTINEL_NODE_ID)) return false;
    }
    return anyVisited ? true : undefined;
  },
});

// Cross-analysis edge: the block analysis consults `purityScopeAnalysis`
// when it hits a nested `FunctionDef` stmt (to learn the nested function's
// purity verdict). Declared post-hoc because both analyses reference each
// other. The factory returns `edges` as a plain (unfrozen) array so late
// amendments are safe. Wake-up path: when the nested fd's scope-analysis
// writes for `functionId`, project to the outer block containing that `def` stmt
// via `topology.blockOfNode(functionId)` — the FunctionDef's own node id lives in
// the enclosing unit's indexing walk, so a direct topology lookup hits the
// caller's block.
const scopeToBlock: EdgeSpec<BasicBlock> = {
  on: "fact",
  analysis: purityScopeAnalysis,
  wake: (ctx, key) => {
    if (typeof key !== "number") return [];
    const block = ctx.topology.blockOfNode(key);
    return block === undefined ? [] : [block];
  },
};
// The scope→block wake re-runs the block transfer (which is on the `.env`
// side); `.facts` is populated as a paired-cell side effect of that pass.
addEdge(purityBlockAnalysis.env, scopeToBlock);
