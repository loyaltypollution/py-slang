// Must-backward type-requirement analysis — the fourth DFA quadrant
// (backward direction, must-merge). Under a return-kind speculation context,
// it propagates the required return type backward through the body,
// producing per-slot type requirements at every program point.
//
// Polarity on `TypeLattice`: TOP = no constraint, BOTTOM = contradiction,
// meet = intersection, join = union. At `unit.cfg.entry` the outEnv is the
// function's pre-body requirement; bindings narrower than TOP are candidate
// parameter-guard sites.
//
// Bypasses `BlockDfaSpec` (like liveness) because the backward visitor pushes
// target requirements *down* into operand slots, which doesn't fit
// `ExprNS.Visitor<L>`. At each `Return e` the transfer reads
// `at(ctx.currentContext, returnKindNarrowing, functionId)`; a missing
// assumption leaves all requirements at TOP (sound no-op).

import { ExprNS, StmtNS } from "../../../ast-types";
import { TokenType } from "../../../tokenizer";
import { unitOfFunctionId, type Narrowing } from "../../framework/analysis";
import { at, type AssumptionChain, ROOT_CONTEXT } from "../../assumption";
import {
  makeBlockFixpointAnalysis,
  type BlockFixpointAnalysis,
} from "../../framework/dfa-factory";
import type { Unit } from "../../framework/function-unit";
import type { FunctionId } from "../../framework/analysis";
import { MutableEnv } from "../../framework/mutable-env";
import type { ObservationBinding } from "../../observation/observation-binding";
import { runtimeReturnChannel } from "../../observation/runtime-analyses";
import { isLocal, type SlotLookup } from "../../framework/slot-table";
import { liftType } from "../type/analysis";
import {
  typeLattice,
  INT_BIT,
  TOP,
  eq,
  integer,
  isSatisfiableType,
  meet,
  type TypeLattice,
} from "../type/lattice";


/** Unconstrained int requirement — kind INT, sign Top. Kind-axis inverse
 *  of `int ⊗ int = int`; sign-level inverse is deferred. */
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
      const required = fd instanceof StmtNS.FunctionDef
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
export const returnKindBinding: ObservationBinding<FunctionId, TypeLattice> = {
  narrowing: returnKindNarrowing,
  source: runtimeReturnChannel,
  lift: liftType,
  resolveUnit: unitOfFunctionId,
};

/** Split view of the per-slot entry requirement. `provable` lists slots
 *  whose requirement is strictly stronger than TOP and satisfiable (guard
 *  candidates). `unprovable` lists slots whose requirement is empty — two
 *  body paths demand incompatible types, so the speculation cannot hold.
 *
 *  Consumers MUST branch on `unprovable` before emitting a guard: an
 *  unprovable slot means every call would gate on a check that always fails. */
export interface EntryRequirement {
  readonly provable: ReadonlyMap<number, TypeLattice>;
  readonly unprovable: ReadonlySet<number>;
}

/** Per-slot entry requirement at `unit.cfg.entry` under `context`. TOP
 *  bindings are omitted. Empty sets when no fact exists (context carries no
 *  return-kind assumption). */
export function requirementAtEntry(
  unit: Unit,
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
