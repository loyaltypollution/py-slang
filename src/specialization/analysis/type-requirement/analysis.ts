// Backward + must type-requirement analysis. Under a return-kind speculation
// context, propagates the required return type backward to produce per-slot
// requirements at every program point. Polarity on `TypeLattice`: TOP = no
// constraint, BOTTOM = contradiction.

import { ExprNS, StmtNS } from "../../../ast-types";
import { TokenType } from "../../../tokenizer";
import { ROOT_CONTEXT, at, type AssumptionChain } from "../../assumption";
import type { Narrowing } from "../../framework/analysis";
import type { ObservationBinding } from "../../observation/observation-binding";
import type { RawKind } from "../../observation/raw-value";
import { runtimeReturnSource } from "../../observation/runtime-analyses";
import type { Function, FunctionId } from "../../program/units/function/function";
import type { FunctionLocator } from "../../program/units/function/manager";
import { isLocal, type SlotLookup } from "../../program/units/function/slot-table";
import { MutableEnv } from "../block-env";
import { makeBlockFixpointAnalysis, type BlockFixpointAnalysis } from "../dfa-factory";
import { liftType } from "../type/analysis";
import {
  INT_BIT,
  TOP,
  eq,
  integer,
  isSatisfiableType,
  meet,
  typeLattice,
  type TypeLattice,
} from "../type/lattice";

/** Unconstrained int requirement — kind INT, sign Top. */
const INT_ANY: TypeLattice = integer();

/** Binary ops where `int ⊗ int = int` (kind-closed). Excludes `/` — Python 3
 *  promotes `int / int` to float, so the kind-inverse would be unsound. */
const INT_CLOSED_BINOPS: ReadonlySet<TokenType> = new Set([
  TokenType.PLUS,
  TokenType.MINUS,
  TokenType.STAR,
  TokenType.DOUBLESLASH,
  TokenType.PERCENT,
]);

/** Push `target` requirement into operand slots via meet with existing
 *  constraint. TOP short-circuits. Handled shapes:
 *    - Variable: direct per-slot meet.
 *    - Grouping / Unary +: transparent.
 *    - Unary - with int-kind target: operand required int (any sign).
 *    - Binary int-closed op with int-kind target: both operands int.
 *    - Ternary with target T: both arms must satisfy T. */
function propagateRequirement(
  expr: ExprNS.Expr,
  target: TypeLattice,
  env: MutableEnv<TypeLattice>,
  slotLookup: SlotLookup,
): void {
  if (target === TOP) return;

  if (expr instanceof ExprNS.Variable) {
    const info = slotLookup(expr.name);
    if (!isLocal(info)) return;
    const existing = env.get(info.slot) ?? TOP;
    const refined = meet(existing, target);
    if (refined !== existing) env.set(info.slot, refined);
    return;
  }

  if (expr instanceof ExprNS.Grouping) {
    propagateRequirement(expr.expression, target, env, slotLookup);
    return;
  }

  if (expr instanceof ExprNS.Unary) {
    const op = expr.operator.type;
    if (op === TokenType.PLUS) {
      propagateRequirement(expr.right, target, env, slotLookup);
    } else if (op === TokenType.MINUS && target.kinds === INT_BIT) {
      propagateRequirement(expr.right, INT_ANY, env, slotLookup);
    }
    return;
  }

  if (
    expr instanceof ExprNS.Binary &&
    target.kinds === INT_BIT &&
    INT_CLOSED_BINOPS.has(expr.operator.type)
  ) {
    propagateRequirement(expr.left, INT_ANY, env, slotLookup);
    propagateRequirement(expr.right, INT_ANY, env, slotLookup);
    return;
  }

  if (expr instanceof ExprNS.Ternary) {
    propagateRequirement(expr.consequent, target, env, slotLookup);
    propagateRequirement(expr.alternative, target, env, slotLookup);
  }
}

/** Backward per-statement transfer. `env` arrives as requirement-AFTER and
 *  becomes requirement-BEFORE. For Assign: lift after-requirement off LHS,
 *  clear it, flow into RHS operands. */
function transferStmtBackward(
  stmt: StmtNS.Stmt,
  env: MutableEnv<TypeLattice>,
  slotLookup: SlotLookup,
  returnRequirement: TypeLattice | undefined,
): void {
  switch (stmt.kind) {
    case "Assign":
    case "AnnAssign": {
      const a = stmt as StmtNS.Assign | StmtNS.AnnAssign;
      if (!(a.target instanceof ExprNS.Variable)) return;
      const info = slotLookup(a.target.name);
      if (!isLocal(info)) return;
      const after = env.get(info.slot) ?? TOP;
      env.clear(info.slot);
      propagateRequirement(a.value, after, env, slotLookup);
      return;
    }
    case "Return": {
      const r = stmt as StmtNS.Return;
      if (r.value !== null && returnRequirement !== undefined) {
        propagateRequirement(r.value, returnRequirement, env, slotLookup);
      }
      return;
    }
    case "For": {
      const f = stmt as StmtNS.For;
      const info = slotLookup(f.target);
      if (isLocal(info)) env.clear(info.slot);
      return;
    }
    case "If":
    case "While":
    case "SimpleExpr":
    case "Assert":
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

/** Backward must-merge analysis. Stored `outEnv` is the block's
 *  requirement-IN (pre-first-statement point). At `unit.cfg.entry` this is
 *  the function's pre-body requirement — parameter-type constraints that, if
 *  checked at entry, discharge the return-kind speculation for the body. */
export const typeRequirementAnalysis: BlockFixpointAnalysis<TypeLattice> =
  makeBlockFixpointAnalysis<TypeLattice>({
    direction: "backward",
    mergeKind: "must",
    valueLattice: typeLattice,
    seedEnv: () => new MutableEnv<TypeLattice>(),
    transferBlock: (ctx, block, inEnv, unit) => {
      const fd = unit.funcAst;
      const required =
        fd instanceof StmtNS.FunctionDef
          ? at(ctx.currentContext, returnKindNarrowing, fd.id)
          : undefined;
      const outEnv = inEnv.snapshot();
      const stmts = block.stmts;
      for (let i = stmts.length - 1; i >= 0; i--) {
        transferStmtBackward(stmts[i], outEnv, unit.slotLookup, required);
      }
      return { outEnv, exprFacts: new Map() };
    },
  });

/** Narrowing dimension for per-function return-kind assumptions, keyed by
 *  FunctionDef.id. Parallel to `paramTypeNarrowing`. The corresponding
 *  observation glue lives in `returnKindBinding` below. */
export const returnKindNarrowing: Narrowing<FunctionId, TypeLattice> = {
  eq,
  blockAnalysis: () => typeRequirementAnalysis,
};

/** Observation binding for `returnKindNarrowing`. An observation at
 *  `functionId` (classified via `liftType`) extends the called unit's
 *  context with `(returnKindNarrowing, functionId, value)`; the analysis
 *  above consumes that at Return statements. `resolveUnit` maps the
 *  functionId to the function's own unit so the extension lands where the
 *  body's requirement-propagation runs. */
export const returnKindBinding: ObservationBinding<
  Function,
  FunctionLocator,
  FunctionId,
  TypeLattice,
  RawKind
> = {
  narrowing: returnKindNarrowing,
  source: runtimeReturnSource,
  lift: liftType,
  resolveUnit: (loc, id) => loc.functionById(id),
};

/** Per-slot entry requirement split by satisfiability. `provable` slots are
 *  guard candidates (stronger than TOP, non-empty). `unprovable` slots have
 *  BOTTOM requirements — speculation cannot hold. */
export interface EntryRequirement {
  readonly provable: ReadonlyMap<number, TypeLattice>;
  readonly unprovable: ReadonlySet<number>;
}

export function requirementAtEntry(
  unit: Function,
  context: AssumptionChain = ROOT_CONTEXT,
): EntryRequirement {
  const provable = new Map<number, TypeLattice>();
  const unprovable = new Set<number>();
  const env = typeRequirementAnalysis.env.store.read(unit.cfg.entry, context);
  for (const slot of env.definedSlots()) {
    const req = env.get(slot);
    if (req === undefined || req === TOP) continue;
    if (isSatisfiableType(req)) provable.set(slot, req);
    else unprovable.add(slot);
  }
  return { provable, unprovable };
}
