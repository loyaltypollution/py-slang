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
import {
  addEdge,
  type Analysis,
  type AnalysisCtx,
  type Narrowing,
} from "../framework/analysis";
import {
  makeBlockFixpointAnalysis,
  nodeIdToBlock,
  type DfaBlockFact,
} from "../framework/dfa-factory";
import { MutableEnv } from "../framework/mutable-env";
import {
  runtimeReturnAnalysis,
  runtimeWriteAnalysis,
} from "../framework/runtime-analyses";
import { isLocal, type SlotLookup } from "../framework/slot-table";
import { liftType } from "../type-analysis/analysis";
import {
  BOTTOM,
  INT_BIT,
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
export const typeRequirementAnalysis: Analysis<BasicBlock, DfaBlockFact<TypeLattice>> =
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

// Monotone widening edge: a ROOT observation change wakes the containing
// block so downstream analyses that read requirement facts under ROOT pick
// up any propagation. Speculative seeding flows through the Context
// dimension as with forward typeAnalysis.
addEdge(typeRequirementAnalysis, {
  on: "fact",
  analysis: runtimeWriteAnalysis,
  wake: nodeIdToBlock,
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
  direction: "backward",
  resolveUnit: (ctx, key) => ctx.unitForFdId(key),
  lift: liftType,
};

/** Read the per-slot type requirement at `unit`'s entry block under
 *  `context`. Slots whose requirement is TOP (no constraint) are omitted
 *  from the result. Returns an empty map when the analysis hasn't yet
 *  produced a fact for this (unit, context) — typically because the
 *  context carries no return-kind assumption and the analysis short-
 *  circuited. Consumers: guard-hoisting, redundant-check elimination.
 *
 *  A slot mapping to BOTTOM signals "two paths of the body demand
 *  incompatible types for this slot" — the return-kind speculation cannot
 *  be proved. Callers must treat BOTTOM as an unprovable-speculation
 *  signal, not as a valid type requirement. */
export function requirementAtEntry(
  factStore: FactStore,
  unit: FunctionUnit,
  context: Context = ROOT_CONTEXT,
): Map<number, TypeLattice> {
  const fact = factStore.tryRead(typeRequirementAnalysis, unit.cfg.entry, context);
  const result = new Map<number, TypeLattice>();
  if (fact === undefined) return result;
  for (const slot of fact.outEnv.definedSlots()) {
    const req = fact.outEnv.get(slot);
    if (req !== undefined && req !== TOP) result.set(slot, req);
  }
  return result;
}
