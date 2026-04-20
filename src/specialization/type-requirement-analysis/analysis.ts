// Must-backward type-requirement analysis. This is the codebase's concrete
// exercised example of the fourth classical DFA quadrant: backward direction,
// must-merge. Under a return-kind speculation context, it propagates the
// required return type backward through the unit's body, producing per-slot
// type requirements at every program point.
//
// Polarity: in the underlying `TypeLattice`, TOP = any type (no constraint),
// BOTTOM = empty (contradiction), meet = intersection, join = union. A slot
// binding of TOP means "no downstream use demands anything of this slot";
// BOTTOM means "two paths demand incompatible types — the speculation is
// unprovable here." The entry block's outEnv is the function's pre-body
// requirement: slot bindings there that are narrower than TOP are candidate
// parameter-guard sites.
//
// Contract parity with liveness (the other backward analysis): we bypass
// `BlockDfaSpec` and build the block fixpoint directly with a custom
// `transferBlock`, because the backward visitor pushes a target requirement
// *down* into operand slots rather than bubbling a computed fact *up* — the
// `ExprNS.Visitor<L>` shape `BlockDfaSpec.makeExprVisitor` prescribes doesn't
// model that dataflow direction.
//
// The seed is context-driven: at each `Return e`, the analysis reads
// `findAssumption(ctx.currentContext, returnKindNarrowing, functionId)`. When the
// context carries no assumption (ROOT, or a chain without a return-kind
// link for this functionId), the transfer is sound-no-op: all requirements stay
// at TOP. Consumers (entry-guard hoisting, redundant-check elimination,
// unboxing) observe the analysis result via `requirementAtEntry` or direct
// analysis-store reads.

import { ExprNS, StmtNS } from "../../ast-types";
import { TokenType } from "../../tokens";
import type { BasicBlock } from "../framework/cfg";
import type { Unit } from "../framework/function-unit";
import {
  ROOT_CONTEXT,
  findAssumption,
  type AssumptionChain,
} from "../framework/context";
import {
  type Narrowing,
} from "../framework/analysis";
import {
  makeBlockFixpointAnalysis,
  type BlockFixpointAnalysis,
  type BlockPassResult,
} from "../framework/dfa-factory";
import { MutableEnv } from "../framework/mutable-env";
import { runtimeReturnAnalysis } from "../framework/runtime-analyses";
import { isLocal, type SlotLookup } from "../framework/slot-table";
import type { FunctionId } from "../framework/key-spaces";
import { liftType } from "../type-analysis/analysis";
import {
  BOTTOM,
  INT_BIT,
  TOP,
  eq,
  integer,
  isSatisfiableType,
  join,
  leq,
  meet,
  type TypeLattice,
} from "../type-analysis/lattice";


/** Unconstrained int requirement — kind INT, sign unknown (Top). The
 *  conservative inverse of `int + int = int`: if the result is required to
 *  be int, either operand being int suffices on the kind axis. Used when
 *  the target requirement's kind mask is exactly `INT_BIT`; sign-level
 *  inverse is deferred to a later refinement. */
const INT_ANY: TypeLattice = integer();

/** Binary ops whose kind-axis inverse is "both operands int ⇒ result int".
 *  `/` (true division) is NOT included — Python 3 promotes `int / int` to
 *  float, so the inverse would be unsound. `//` (floor div) and `%` stay
 *  int-closed on int operands. */
const INT_CLOSED_BINOPS: ReadonlySet<TokenType> = new Set([
  TokenType.PLUS,
  TokenType.MINUS,
  TokenType.STAR,
  TokenType.DOUBLESLASH,
  TokenType.PERCENT,
]);

/** Push `target` into the operand slots of `expr` as a requirement, via
 *  meet with whatever constraint the slot already carries. TOP targets
 *  short-circuit — nothing to propagate. Handled expression shapes:
 *    - Variable: direct per-slot meet.
 *    - Grouping: transparent.
 *    - Unary +: identity, recurse with same target.
 *    - Unary - with int-kind target: operand required int (any sign).
 *      Sign inversion of the refinement is deferred — `INT_ANY` preserves
 *      the kind axis and drops sign, which is sound (weakens the operand
 *      requirement).
 *    - Binary {+, -, *, //, %} with int-kind target: both operands must
 *      be int (kind-level). For each op, `int ⊗ int = int` holds on the
 *      kind axis; sign-level inverse deferred.
 *    - Ternary with target T: both consequent and alternative must
 *      satisfy T (forward joins them to a single result kind). Predicate
 *      is not visited — its type doesn't flow into the result.
 *  Other shapes impose no requirement — sound no-op, guards don't get
 *  hoisted through them. Extensions add cases; every addition must
 *  preserve monotonicity (stronger `target` → stronger operand
 *  requirement) and soundness (requirement implies target on forward). */
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
    if (refined === existing) return;
    env.set(info.slot, refined);
    return;
  }

  if (expr instanceof ExprNS.Grouping) {
    propagateRequirement(expr.expression, target, env, slotLookup);
    return;
  }

  if (expr instanceof ExprNS.Unary) {
    if (expr.operator.type === TokenType.PLUS) {
      propagateRequirement(expr.right, target, env, slotLookup);
    } else if (
      expr.operator.type === TokenType.MINUS &&
      target.kinds === INT_BIT
    ) {
      propagateRequirement(expr.right, INT_ANY, env, slotLookup);
    }
    return;
  }

  if (expr instanceof ExprNS.Binary) {
    if (
      target.kinds === INT_BIT &&
      INT_CLOSED_BINOPS.has(expr.operator.type)
    ) {
      propagateRequirement(expr.left, INT_ANY, env, slotLookup);
      propagateRequirement(expr.right, INT_ANY, env, slotLookup);
    }
    return;
  }

  if (expr instanceof ExprNS.Ternary) {
    propagateRequirement(expr.consequent, target, env, slotLookup);
    propagateRequirement(expr.alternative, target, env, slotLookup);
    return;
  }
}

/** Backward per-statement transfer. `env` arrives as the requirement-AFTER
 *  the statement; on return it is the requirement-BEFORE. For Assign we
 *  lift the after-requirement off the LHS, clear it (pre-assignment the
 *  slot doesn't exist), and flow it into RHS operands. */
function transferStmtBackward(
  stmt: StmtNS.Stmt,
  env: MutableEnv<TypeLattice>,
  slotLookup: SlotLookup,
  returnRequirement: TypeLattice | undefined,
): void {
  switch (stmt.kind) {
    case "Assign": {
      const a = stmt as StmtNS.Assign;
      if (!(a.target instanceof ExprNS.Variable)) return;
      const info = slotLookup(a.target.name);
      if (!isLocal(info)) return;
      const after = env.get(info.slot) ?? TOP;
      env.clear(info.slot);
      propagateRequirement(a.value, after, env, slotLookup);
      return;
    }
    case "AnnAssign": {
      const a = stmt as StmtNS.AnnAssign;
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

function transferBlockBackward(
  block: BasicBlock,
  inEnv: MutableEnv<TypeLattice>,
  slotLookup: SlotLookup,
  returnRequirement: TypeLattice | undefined,
): BlockPassResult<TypeLattice> {
  const outEnv = inEnv.snapshot();
  const stmts = block.stmts;
  for (let i = stmts.length - 1; i >= 0; i--) {
    transferStmtBackward(stmts[i], outEnv, slotLookup, returnRequirement);
  }
  return { outEnv, exprFacts: new Map() };
}

/** Backward must-merge analysis. The stored `outEnv` is the block's
 *  requirement-IN (i.e., requirement at the block's pre-first-statement
 *  program point). At `unit.cfg.entry` this is the function's pre-body
 *  requirement — the set of parameter-type constraints that, if checked
 *  at entry, discharge the return-kind speculation for the whole body. */
export const typeRequirementAnalysis: BlockFixpointAnalysis<TypeLattice> =
  makeBlockFixpointAnalysis<TypeLattice>({
    debugName: "typeRequirementAnalysis",
    direction: "backward",
    mergeKind: "must",
    valueLattice: { bottom: BOTTOM, top: TOP, join, meet, leq, eq },
    seedEnv: () => new MutableEnv<TypeLattice>(),
    transferBlock: (ctx, block, inEnv, unit) => {
      const fd = unit.funcAst;
      const required = fd instanceof StmtNS.FunctionDef
        ? findAssumption(ctx.currentContext, returnKindNarrowing, fd.id)
        : undefined;
      return transferBlockBackward(block, inEnv, unit.slotLookup, required);
    },
    refineOnEdge: (env, _edge) => env,
  });

/** Narrowing dimension for per-function return-kind assumptions. Keyed by
 *  FunctionDef.id (functionId). Parallel to `typeNarrowing` /
 *  `constNarrowing` — a namespace token for AssumptionChain bindings,
 *  never scheduled, owns no analysis store. Carries both the identity
 *  fields (`id`, `debugName`, `keySpace`, `eq` — the interner's canonical
 *  dedup relation) and the narrowing metadata (`blockAnalysis`,
 *  `observationSource`, `lift`, …) the worklist's observation→context
 *  translator consumes. An observation at `functionId` (classified via
 *  `liftType`) extends the called unit's context with
 *  `(returnKindNarrowing, functionId, value)`; the analysis above consumes
 *  that assumption at Return statements. `resolveUnit` maps the functionId
 *  to the function's own unit (not its containing caller) so the extension
 *  lands where the body's requirement-propagation runs. */
export const returnKindNarrowing: Narrowing<FunctionId, TypeLattice> = {
  id: Symbol("returnKindNarrowing"),
  debugName: "returnKindNarrowing",
  keySpace: "functionId",
  eq,
  blockAnalysis: () => typeRequirementAnalysis,
  observationSource: runtimeReturnAnalysis,
  resolveUnit: (ctx, key) => ctx.topology.unitOfFunctionId(key),
  // Lineage is tracked over the entry block's requirement-IN env — the
  // fact surface that drives guard hoisting. Reading `.env` here matches
  // what `requirementAtEntry` below consumes.
  lineageValue: (unit, _functionId, context) =>
    context.tryRead(typeRequirementAnalysis.env, unit.cfg.entry),
  lineageEq: (a, b) => typeRequirementAnalysis.env.storeAlgebra.eq(
    a as MutableEnv<TypeLattice>,
    b as MutableEnv<TypeLattice>,
  ),
  lift: liftType,
};

/** Split view of the per-slot entry requirement for `unit` under
 *  `context`. `provable` holds slots whose requirement is strictly
 *  stronger than TOP (no constraint) and satisfiable by some concrete
 *  runtime value — the guard candidates. `unprovable` holds slots whose
 *  requirement is empty (no runtime value satisfies it) — two paths of
 *  the body demand incompatible types for that slot, and the speculation
 *  cannot hold for any input.
 *
 *  Consumers MUST branch on `unprovable` before emitting a guard: an
 *  unprovable slot means the speculation is statically impossible, so
 *  guard emission would gate every call on a check that always fails. */
export interface EntryRequirement {
  readonly provable: ReadonlyMap<number, TypeLattice>;
  readonly unprovable: ReadonlySet<number>;
}

/** Read the per-slot type requirement at `unit`'s entry block under
 *  `context`. Returns the split `EntryRequirement`. TOP bindings (no
 *  constraint) are omitted from both halves. Returns empty sets when the
 *  analysis hasn't yet produced a fact for this (unit, context) —
 *  typically because the context carries no return-kind assumption and
 *  the analysis short-circuited. Consumers: guard-hoisting, redundant-
 *  check elimination.
 *
 *  Satisfiability uses `isSatisfiableType`: `TypeLattice` canonicalizes
 *  empty refinements back to `BOTTOM`, so it is the domain-level question
 *  "does normalization collapse this to bottom?". */
export function requirementAtEntry(
  unit: Unit,
  context: AssumptionChain = ROOT_CONTEXT,
): EntryRequirement {
  const provable = new Map<number, TypeLattice>();
  const unprovable = new Set<number>();
  const env = context.tryRead(typeRequirementAnalysis.env, unit.cfg.entry);
  if (env === undefined) return { provable, unprovable };
  for (const slot of env.definedSlots()) {
    const req = env.get(slot);
    if (req === undefined || req === TOP) continue;
    if (isSatisfiableType(req)) provable.set(slot, req);
    else unprovable.add(slot);
  }
  return { provable, unprovable };
}
