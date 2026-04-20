// Dead-store elimination. Splices out `x = <pure expr>` when x is not live
// at that program point (i.e. no downstream read before a re-definition).
//
// Idempotent: once an assignment is spliced out, it no longer matches the
// pattern. Designed to fire *after* dead-branch and constant-folding have
// removed the only consumers of a slot; this is the pass that collapses the
// runtime-const "gate" pattern described in the poster:
//
//     x = seed - seed     # const 0  (via speculation → const-folding)
//     k = seed // seed    # const 1
//     if x < k: ...       # const True → else arm dropped by dead-branch
//
// After dead-branch, nothing reads `x` or `k`; DSE drops both assignments.
//
// Mutates the AST (`unit.body` and nested compound-stmt bodies) directly,
// mirroring `dead-branch.ts`. `block.stmts` is a *copy* built by `buildCFG`
// and is discarded on CFG rebuild — splicing it alone would loop forever.

import { ExprNS, StmtNS } from "../../ast-types";
// `StmtNS.FileInput` import via namespace below.
import type { BasicBlock } from "../framework/cfg";
import type { Unit } from "../framework/function-unit";
import { isLocal, type SlotLookup } from "../framework/slot-table";
import { type TransformFactView, unitSweepRule } from "../framework/transform-rule";
import { livenessAnalysis, liveOutOf } from "../liveness-analysis/analysis";
import { LIVE } from "../liveness-analysis/lattice";
import { MutableEnv } from "../framework/mutable-env";

/** Conservative syntactic purity: an expression whose evaluation cannot
 *  observe or produce side effects and whose elision is safe even if its
 *  slot target is dead. Calls, subscripts, lambdas (capture semantics are
 *  not tracked by liveness here), and list literals are excluded. */
function isPureRhs(expr: ExprNS.Expr, slotLookup: SlotLookup): boolean {
  if (expr instanceof ExprNS.Literal) return true;
  if (expr instanceof ExprNS.BigIntLiteral) return true;
  if (expr instanceof ExprNS.None) return true;
  if (expr instanceof ExprNS.Complex) return true;
  if (expr instanceof ExprNS.Variable) {
    const info = slotLookup(expr.name);
    return isLocal(info);
  }
  if (expr instanceof ExprNS.Grouping) return isPureRhs(expr.expression, slotLookup);
  if (expr instanceof ExprNS.Unary) return isPureRhs(expr.right, slotLookup);
  if (expr instanceof ExprNS.Binary) {
    return isPureRhs(expr.left, slotLookup) && isPureRhs(expr.right, slotLookup);
  }
  if (expr instanceof ExprNS.Compare) {
    return isPureRhs(expr.left, slotLookup) && isPureRhs(expr.right, slotLookup);
  }
  if (expr instanceof ExprNS.BoolOp) {
    return isPureRhs(expr.left, slotLookup) && isPureRhs(expr.right, slotLookup);
  }
  if (expr instanceof ExprNS.Ternary) {
    return isPureRhs(expr.predicate, slotLookup)
      && isPureRhs(expr.consequent, slotLookup)
      && isPureRhs(expr.alternative, slotLookup);
  }
  // Call, Subscript, List, Starred, Lambda, MultiLambda: impure.
  return false;
}

function markReads(expr: ExprNS.Expr, env: MutableEnv<true>, slotLookup: SlotLookup): void {
  if (expr instanceof ExprNS.Variable) {
    const info = slotLookup(expr.name);
    if (isLocal(info)) env.set(info.slot, LIVE);
    return;
  }
  if (expr instanceof ExprNS.Binary || expr instanceof ExprNS.Compare || expr instanceof ExprNS.BoolOp) {
    markReads(expr.left, env, slotLookup);
    markReads(expr.right, env, slotLookup);
    return;
  }
  if (expr instanceof ExprNS.Unary) {
    markReads(expr.right, env, slotLookup);
    return;
  }
  if (expr instanceof ExprNS.Grouping) {
    markReads(expr.expression, env, slotLookup);
    return;
  }
  if (expr instanceof ExprNS.Ternary) {
    markReads(expr.predicate, env, slotLookup);
    markReads(expr.consequent, env, slotLookup);
    markReads(expr.alternative, env, slotLookup);
    return;
  }
  if (expr instanceof ExprNS.Call) {
    markReads(expr.callee, env, slotLookup);
    for (const a of expr.args) markReads(a, env, slotLookup);
    return;
  }
  if (expr instanceof ExprNS.List) {
    for (const e of expr.elements) markReads(e, env, slotLookup);
    return;
  }
  if (expr instanceof ExprNS.Subscript) {
    markReads(expr.value, env, slotLookup);
    markReads(expr.index, env, slotLookup);
    return;
  }
  if (expr instanceof ExprNS.Starred) {
    markReads(expr.value, env, slotLookup);
    return;
  }
  // Lambda / MultiLambda / Literal / None / BigInt / Complex: no reads relevant here.
}

/** Apply backward transfer of `stmt` to `env` (which represents live-out of
 *  the statement on entry; becomes live-in on return). Matches the liveness
 *  analysis's `transferStmtBackward` but inlined to avoid leaking that
 *  internal helper. */
function applyBackward(
  stmt: StmtNS.Stmt,
  env: MutableEnv<true>,
  slotLookup: SlotLookup,
): void {
  switch (stmt.kind) {
    case "Assign": {
      const a = stmt as StmtNS.Assign;
      if (a.target instanceof ExprNS.Variable) {
        const info = slotLookup(a.target.name);
        if (isLocal(info)) env.clear(info.slot);
      } else {
        markReads(a.target, env, slotLookup);
      }
      markReads(a.value, env, slotLookup);
      return;
    }
    case "AnnAssign": {
      const a = stmt as StmtNS.AnnAssign;
      const info = slotLookup(a.target.name);
      if (isLocal(info)) env.clear(info.slot);
      markReads(a.value, env, slotLookup);
      return;
    }
    case "If":
      markReads((stmt as StmtNS.If).condition, env, slotLookup);
      return;
    case "While":
      markReads((stmt as StmtNS.While).condition, env, slotLookup);
      return;
    case "For": {
      const f = stmt as StmtNS.For;
      const info = slotLookup(f.target);
      if (isLocal(info)) env.clear(info.slot);
      markReads(f.iter, env, slotLookup);
      return;
    }
    case "Return": {
      const r = stmt as StmtNS.Return;
      if (r.value) markReads(r.value, env, slotLookup);
      return;
    }
    case "SimpleExpr":
      markReads((stmt as StmtNS.SimpleExpr).expression, env, slotLookup);
      return;
    case "Assert":
      markReads((stmt as StmtNS.Assert).value, env, slotLookup);
      return;
    default:
      return;
  }
}

/** Scan the unit's AST for every Lambda/MultiLambda expression and collect
 *  the set of this unit's local slots that appear as free variable reads
 *  inside any lambda body. Liveness's `ReadCollector` does not walk lambda
 *  bodies (they have their own scope and the unit's `slotLookup` can't
 *  resolve lambda-local names), so those reads are invisible to the
 *  backward transfer. A captured local can be read whenever the lambda is
 *  later called — a site the ReadCollector also can't see (the Call node
 *  references the lambda by name, not the captured slot). DSE must
 *  conservatively treat these slots as always-live; otherwise it would
 *  splice a dead-looking `x = 1` whose only reader is `lambda: x`.
 *
 *  Implementation: walk every expression in the unit's body; for each
 *  Variable seen inside a Lambda/MultiLambda body, attempt `slotLookup`
 *  via a safe wrapper (the lookup throws on unknown names) and add it to
 *  the set iff it resolves to a local of THIS unit. Names that resolve in
 *  the lambda's own scope (or an inner scope) throw and are correctly
 *  ignored; names that resolve to builtins are non-local and also ignored. */
function escapedLocalSlots(unit: Unit): Set<number> {
  const escaped = new Set<number>();
  const tryLookupLocal = (name: ExprNS.Variable["name"]): number | undefined => {
    try {
      const info = unit.slotLookup(name);
      return isLocal(info) ? info.slot : undefined;
    } catch {
      return undefined;
    }
  };
  const walkExprInsideLambda = (expr: ExprNS.Expr): void => {
    if (expr instanceof ExprNS.Variable) {
      const slot = tryLookupLocal(expr.name);
      if (slot !== undefined) escaped.add(slot);
      return;
    }
    // Recurse through anything else that has child expression fields.
    for (const key of Object.keys(expr)) {
      const child = (expr as unknown as Record<string, unknown>)[key];
      if (child instanceof ExprNS.Expr) walkExprInsideLambda(child);
      else if (Array.isArray(child)) {
        for (const item of child) {
          if (item instanceof ExprNS.Expr) walkExprInsideLambda(item);
        }
      }
    }
  };
  const walkForLambdas = (node: unknown, seen: WeakSet<object>): void => {
    if (node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (node instanceof ExprNS.Lambda) {
      walkExprInsideLambda(node.body);
      return;
    }
    if (node instanceof ExprNS.MultiLambda) {
      // MultiLambda bodies are statement lists; recurse through them looking
      // for nested expressions. Reuse the generic walker.
      for (const stmt of node.body) walkForLambdas(stmt, seen);
      return;
    }
    const obj = node as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      const child = obj[key];
      if (Array.isArray(child)) {
        for (const item of child) walkForLambdas(item, seen);
      } else if (typeof child === "object" && child !== null) {
        walkForLambdas(child, seen);
      }
    }
  };
  for (const stmt of unit.body) walkForLambdas(stmt, new WeakSet());
  return escaped;
}

/** Build `Map<StmtNS.Stmt, Set<number>>` of per-statement live-OUT for every
 *  statement in every block of `unit`. The map is keyed by the AST-statement
 *  object itself (identity), so downstream consumers can look up liveness
 *  while walking the AST without needing to know the containing block. */
function buildLiveOutMap(
  unit: Unit,
): Map<StmtNS.Stmt, Set<number>> {
  const out = new Map<StmtNS.Stmt, Set<number>>();
  for (const block of unit.blockMap.values()) {
    const env = liveOutOf(block);
    const stmts = block.stmts;
    for (let i = stmts.length - 1; i >= 0; i--) {
      const snapshot = new Set<number>();
      for (const s of env.definedSlots()) snapshot.add(s);
      // If the same statement object appears in multiple blocks (it shouldn't
      // under current CFG construction), the last one written wins.
      // Compound-statement headers (If/While/For) are pushed into their
      // header block with only the condition/iter as their effect; the
      // statement body lives in successor blocks. We only look up Assign
      // here, which only ever lives in straight-line blocks, so this is safe.
      out.set(stmts[i], snapshot);
      applyBackward(stmts[i], env, unit.slotLookup);
    }
  }
  return out;
}

/** Recursive AST walk mirroring dead-branch.ts: sweep a statement list,
 *  splicing Assign statements whose target is dead and whose RHS is pure.
 *  Recurses into compound-statement bodies. Returns true iff any splice
 *  occurred. */
function sweepStmts(
  stmts: StmtNS.Stmt[],
  liveOutMap: ReadonlyMap<StmtNS.Stmt, Set<number>>,
  slotLookup: SlotLookup,
  escaped: ReadonlySet<number>,
): boolean {
  let changed = false;
  let i = 0;
  while (i < stmts.length) {
    const s = stmts[i];
    if (s instanceof StmtNS.Assign && s.target instanceof ExprNS.Variable) {
      const info = slotLookup(s.target.name);
      const liveOut = liveOutMap.get(s);
      if (
        isLocal(info)
        && liveOut !== undefined
        && !liveOut.has(info.slot)
        && !escaped.has(info.slot)   // captured by a lambda — treat as always live
        && isPureRhs(s.value, slotLookup)
      ) {
        stmts.splice(i, 1);
        changed = true;
        continue;
      }
    }
    if (s instanceof StmtNS.If) {
      if (sweepStmts(s.body, liveOutMap, slotLookup, escaped)) changed = true;
      if (s.elseBlock && sweepStmts(s.elseBlock, liveOutMap, slotLookup, escaped)) changed = true;
    } else if (s instanceof StmtNS.While) {
      if (sweepStmts(s.body, liveOutMap, slotLookup, escaped)) changed = true;
    } else if (s instanceof StmtNS.For) {
      if (sweepStmts(s.body, liveOutMap, slotLookup, escaped)) changed = true;
    }
    i++;
  }
  return changed;
}

export const deadStoreRule = unitSweepRule(
  "deadStoreRule",
  (unit: Unit, facts: TransformFactView) => {
    // Skip the module (FileInput) scope. Module-top-level names are part of
    // the program's observable namespace — other modules can import them,
    // REPL/tool consumers can inspect them after execution, and the
    // conductor's benchmark harness reads module-global bindings. Eliding
    // a top-level `x = 1` whose slot has no syntactic reader inside the
    // module would change observable state. Function-scope locals, by
    // contrast, are dead at return; DSE on them is always sound.
    if (unit.funcAst instanceof StmtNS.FileInput) return false;
    // Seed the Reading from the entry block's liveness env — this is the
    // anchor fact the rule gates on. readAt always yields a Reading at
    // the view's bound context.
    const seed = facts.readAt(livenessAnalysis.env, unit.cfg.entry);
    const liveOutMap = buildLiveOutMap(unit);
    const escaped = escapedLocalSlots(unit);
    return sweepStmts(facts.bodyAtWitness(unit, seed), liveOutMap, unit.slotLookup, escaped);
  },
  [{ on: "fact", analysis: livenessAnalysis.env, wake: (_ctx, block) => [(block as BasicBlock).unit] }],
);
