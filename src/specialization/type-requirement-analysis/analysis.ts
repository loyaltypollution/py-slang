// Must-backward type-requirement analysis. Fourth classical DFA quadrant:
// backward direction, must-merge. Under a return-kind speculation context,
// propagates the required return type backward through the unit's body,
// producing per-slot type requirements at every program point.
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
// `findAssumption(ctx.currentContext, returnKindHandle, fdId)`. When the
// context carries no assumption (ROOT, or a chain without a return-kind
// link for this fdId), the transfer is sound-no-op: all requirements stay
// at TOP. Consumers (entry-guard hoisting, redundant-check elimination,
// unboxing) observe the analysis result via `requirementAtEntry` or direct
// fact-store reads.

import { ExprNS, StmtNS } from "../../ast-types";
import { TokenType } from "../../tokens";
import type { BasicBlock } from "../framework/cfg";
import type { FactStore } from "../framework/fact-store";
import type { FunctionUnit } from "../framework/function-unit";
import {
  ROOT_CONTEXT,
  findAssumption,
  type Context,
} from "../framework/context";
import type {
  Analysis,
  AnalysisCtx,
  Narrowing,
} from "../framework/analysis";
import {
  makeBlockFixpointAnalysis,
  type BlockFixpointAnalysis,
  type DfaBlockFact,
} from "../framework/dfa-factory";
import { MutableEnv } from "../framework/mutable-env";
import { runtimeReturnAnalysis } from "../framework/runtime-analyses";
import { isLocal, type SlotLookup } from "../framework/slot-table";
import { liftType } from "../type-analysis/analysis";
import {
  BOOL_BIT,
  BOTTOM,
  CLOSURE_BIT,
  COMPLEX_BIT,
  FLOAT_BIT,
  INT_BIT,
  NULL_BIT,
  STR_BIT,
  TOP,
  eq,
  integer,
  join,
  leq,
  meet,
  type TypeLattice,
} from "../type-analysis/lattice";

/** Narrowing-chain identity for per-function return-kind assumptions. Keyed
 *  by FunctionDef.id (fdId). The handle is never scheduled — its transfer
 *  is a no-op and the fact store never carries cells under it. Its sole
 *  role is to give the Context chain a stable namespace for return-kind
 *  bindings, parallel to `typeExprHandle` / `constExprHandle`.
 *
 *  `lattice` matches the TypeLattice semantics so Context's canonical
 *  dedup (`lattice.eq` at `extendContext`) behaves correctly. */
export const returnKindHandle: Analysis<number, TypeLattice> = {
  id: Symbol("returnKindHandle"),
  debugName: "returnKindHandle",
  lattice: { bottom: BOTTOM, leq, join, eq },
  edges: [],
  tier: "analysis",
  transfer(_factStore: FactStore, _ctx: AnalysisCtx, _key: number): TypeLattice | undefined {
    return undefined;
  },
};

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
): DfaBlockFact<TypeLattice> {
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
    transferBlock: (_factStore, ctx, block, inEnv, unit) => {
      const fd = unit.funcAst;
      const required = fd instanceof StmtNS.FunctionDef
        ? findAssumption(ctx.currentContext, returnKindHandle, fd.id)
        : undefined;
      return transferBlockBackward(block, inEnv, unit.slotLookup, required);
    },
    refineOnEdge: (env, _edge) => env,
  });

/** Narrowing dimension: runtime return observations. An observation at
 *  `fdId` (classified via `liftType`) extends the called unit's context
 *  with `(returnKindHandle, fdId, value)`; the analysis above consumes
 *  that assumption at Return statements. `resolveUnit` maps the fdId to
 *  the function's own unit (not its containing caller) so the extension
 *  lands where the body's requirement-propagation runs. */
export const returnKindNarrowing: Narrowing<TypeLattice> = {
  handle: returnKindHandle,
  blockAnalysis: () => typeRequirementAnalysis,
  observationSource: runtimeReturnAnalysis,
  resolveUnit: (ctx, key) => ctx.unitForFdId(key),
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

/** True iff `v` describes at least one concrete runtime value. Empty
 *  kinds mask means outright BOTTOM. A kind bit with an empty refinement
 *  (e.g. `kinds=INT_BIT` with `intRef=0`, as produced by
 *  `meet(INT_POS, INT_NEG)`) is structurally non-BOTTOM but semantically
 *  admits no integer — the distinction matters because `eq(v, BOTTOM)`
 *  alone would misclassify such a slot as provable. Refinementless kinds
 *  (STR, NULL, CLOSURE, COMPLEX) are satisfiable whenever their bit is
 *  set; refinement-bearing kinds (INT, BOOL, FLOAT) require a non-zero
 *  refinement bit. */
function isSatisfiable(v: TypeLattice): boolean {
  if (v.kinds === 0) return false;
  const refinementless = STR_BIT | NULL_BIT | CLOSURE_BIT | COMPLEX_BIT;
  if ((v.kinds & refinementless) !== 0) return true;
  if ((v.kinds & INT_BIT) !== 0 && v.intRef !== 0) return true;
  if ((v.kinds & BOOL_BIT) !== 0 && v.boolRef !== 0) return true;
  if ((v.kinds & FLOAT_BIT) !== 0 && v.floatRef !== 0) return true;
  return false;
}

/** Read the per-slot type requirement at `unit`'s entry block under
 *  `context`. Returns the split `EntryRequirement`. TOP bindings (no
 *  constraint) are omitted from both halves. Returns empty sets when the
 *  analysis hasn't yet produced a fact for this (unit, context) —
 *  typically because the context carries no return-kind assumption and
 *  the analysis short-circuited. Consumers: guard-hoisting, redundant-
 *  check elimination. */
export function requirementAtEntry(
  factStore: FactStore,
  unit: FunctionUnit,
  context: Context = ROOT_CONTEXT,
): EntryRequirement {
  const provable = new Map<number, TypeLattice>();
  const unprovable = new Set<number>();
  const fact = factStore.tryRead(typeRequirementAnalysis, unit.cfg.entry, context);
  if (fact === undefined) return { provable, unprovable };
  for (const slot of fact.outEnv.definedSlots()) {
    const req = fact.outEnv.get(slot);
    if (req === undefined || req === TOP) continue;
    if (isSatisfiable(req)) provable.set(slot, req);
    else unprovable.add(slot);
  }
  return { provable, unprovable };
}
