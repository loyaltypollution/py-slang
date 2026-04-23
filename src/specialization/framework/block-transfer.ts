import { ExprNS, StmtNS } from "../../ast-types";
import type { BasicBlock } from "./cfg";
import type { Speculation } from "./assumption-chain";
import type { BlockDfaSpec, BlockPassResult } from "./dfa-factory";
import type { Unit } from "./function-unit";
import type { MutableEnv } from "./mutable-env";
import { isLocal, type SlotLookup } from "./slot-table";

/** Statement-level transfer; updates `env` in place. If/While/For headers evaluate condition/iter only. */
function transferStmt<L>(
  stmt: StmtNS.Stmt,
  env: MutableEnv<L>,
  visitor: ExprNS.Visitor<L>,
  module: BlockDfaSpec<L>,
  slotLookup: SlotLookup,
): void {
  switch (stmt.kind) {
    case "Assign": {
      const a = stmt as StmtNS.Assign;
      const val = a.value.accept(visitor);
      if (!(a.target instanceof ExprNS.Variable)) return;
      const info = slotLookup(a.target.name);
      if (isLocal(info)) env.set(info.slot, val);
      return;
    }
    case "AnnAssign": {
      const a = stmt as StmtNS.AnnAssign;
      const val = a.value.accept(visitor);
      const info = slotLookup(a.target.name);
      if (isLocal(info)) env.set(info.slot, val);
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
      f.iter.accept(visitor);
      const info = slotLookup(f.target);
      if (isLocal(info)) env.set(info.slot, module.top);
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

// Shared empty facts singleton. Blocks that record zero expr facts (e.g. a
// stmt block with no interesting expressions under this analysis) return
// this instead of allocating a fresh Map per transfer. `factsJoin`/`factsLeq`
// in the DFA factory short-circuit on `size === 0`, so the shared instance
// is never mutated by the framework. Typed ReadonlyMap; callers that cast
// away readonly and mutate would corrupt every zero-fact block.
const EMPTY_FACTS: ReadonlyMap<number, unknown> = new Map();

/** Compute OUT env + per-node expr facts for `block`.
 *
 *  Contract: `inEnv` is treated as caller-owned and mutable — this function
 *  writes directly into it via `env.set(...)` in `transferStmt`. The DFA
 *  factory's `inEnvFor` guarantees a fresh/snapshot env on every call; an
 *  extra snapshot here would be redundant allocation per block per fixpoint
 *  pass. If a future caller reuses an env they still hold a live reference
 *  to, they MUST snapshot before passing it in. */
export function transferBlock<L>(
  block: BasicBlock,
  inEnv: MutableEnv<L>,
  module: BlockDfaSpec<L>,
  unit: Unit,
  context: Speculation,
): BlockPassResult<L> {
  const outEnv = inEnv;
  // Lazy fact-map allocation: most blocks don't record per-expr facts under
  // any given analysis, and the DFA factory's fact lattice treats empty maps
  // as bottom. Allocate on first recordExprFact, share EMPTY_FACTS otherwise.
  let exprFacts: Map<number, L> | undefined;
  const recordExprFact = (nodeId: number, val: L): void => {
    if (exprFacts === undefined) exprFacts = new Map<number, L>();
    exprFacts.set(nodeId, val);
  };
  const slotLookup = unit.slotLookup;
  const visitor = module.makeExprVisitor(outEnv, unit, slotLookup, recordExprFact, context);
  const stmts = block.stmts;
  if (module.direction === "backward") {
    for (let i = stmts.length - 1; i >= 0; i--) {
      transferStmt(stmts[i], outEnv, visitor, module, slotLookup);
    }
  } else {
    for (const stmt of stmts) {
      transferStmt(stmt, outEnv, visitor, module, slotLookup);
    }
  }
  return {
    outEnv,
    exprFacts: exprFacts ?? (EMPTY_FACTS as ReadonlyMap<number, L>),
  };
}
