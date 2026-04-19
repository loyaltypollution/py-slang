// Entry-guard projection: the subset of (unit, context) assumptions that are
// checkable at function entry.
//
// An entry guard is a constraint on a single parameter that can be evaluated
// at call dispatch time — before the callee body begins — so the runtime can
// select or reject a specialized version without executing the body.
//
// v1 projection sources:
//   - direct function-entry parameter observations → param-const / param-type
//     guards, keyed by `ParamKey`
//   - returnKindNarrowing → requirementAtEntry → param-type guards.

import { StmtNS } from "../ast-types";
import type { AssumptionHandle } from "./framework/analysis";
import {
  findAssumption,
  ROOT_CONTEXT,
  type Context,
} from "./framework/context";
import type { Unit } from "./framework/function-unit";
import {
  paramKey,
  paramKeyIndex,
  type ParamKey,
} from "./framework/key-spaces";
import { constEq, type ConstLattice } from "./const-analysis/lattice";
import { requirementAtEntry } from "./type-requirement-analysis/analysis";
import { eq as typeEq, type TypeLattice } from "./type-analysis/lattice";

export type EntryGuard =
  | { kind: "param-const"; paramIndex: number; value: unknown }
  | { kind: "param-type"; paramIndex: number; ty: TypeLattice };

export const paramConstHandle: AssumptionHandle<ParamKey, ConstLattice> = {
  id: Symbol("paramConstHandle"),
  debugName: "paramConstHandle",
  keySpace: "paramKey",
  eq: constEq,
};

export const paramTypeHandle: AssumptionHandle<ParamKey, TypeLattice> = {
  id: Symbol("paramTypeHandle"),
  debugName: "paramTypeHandle",
  keySpace: "paramKey",
  eq: typeEq,
};

export function directParamEntryGuardsFor(
  unit: Unit,
  context: Context,
): readonly EntryGuard[] | undefined {
  if (!(unit.funcAst instanceof StmtNS.FunctionDef)) return undefined;
  const guards: EntryGuard[] = [];
  for (let i = 0; i < unit.funcAst.parameters.length; i++) {
    const key = paramKey(unit.funcAst.id, i);
    const constVal = findAssumption(context, paramConstHandle, key);
    if (constVal?.tag === "const") {
      guards.push({ kind: "param-const", paramIndex: i, value: constVal.value });
      continue;
    }
    const ty = findAssumption(context, paramTypeHandle, key);
    if (ty !== undefined) guards.push({ kind: "param-type", paramIndex: i, ty });
  }
  return guards.length > 0 ? guards : undefined;
}

export function contextIsEntrySpecializable(unit: Unit, context: Context): boolean {
  if (!(unit.funcAst instanceof StmtNS.FunctionDef)) return false;
  for (let cur: Context | undefined = context; cur !== undefined && cur !== ROOT_CONTEXT; cur = cur.parent) {
    const a = cur.assumption;
    if (a === undefined) continue;
    if (a.analysis === paramConstHandle || a.analysis === paramTypeHandle) {
      const index = paramKeyIndex(a.key as ParamKey);
      if (index >= 0 && index < unit.funcAst.parameters.length) continue;
    }
    return false;
  }
  return true;
}

/** Project a (unit, context) pair to the subset of context assumptions that
 *  are checkable at function entry.
 *
 *  Returns `undefined` when:
 *  - the unit has no parameters (FileInput, zero-arg functions), or
 *  - the context carries no entry-guardable assumptions for this unit, or
 *  - the assumption set is not fully provable (unprovable slots present →
 *    specialization would be unsound without mid-body guards).
 *
 *  Returns a non-empty array of guards when all assumptions are provable.
 *  The caller may use this to gate dispatch to a specialized version. */
export function entryGuardsFor(
  unit: Unit,
  context: Context,
): readonly EntryGuard[] | undefined {
  if (!(unit.funcAst instanceof StmtNS.FunctionDef)) return undefined;
  if (unit.funcAst.parameters.length === 0) return undefined;

  const guards: EntryGuard[] = [];
  const direct = directParamEntryGuardsFor(unit, context);
  if (direct !== undefined) guards.push(...direct);

  const { provable, unprovable } = requirementAtEntry(unit, context);
  if (unprovable.size > 0) return undefined;
  for (const [paramIndex, ty] of provable) {
    if (!guards.some(g => g.kind === "param-type" && g.paramIndex === paramIndex)) {
      guards.push({ kind: "param-type", paramIndex, ty });
    }
  }

  return guards.length > 0 ? guards : undefined;
}

function encodeGuard(g: EntryGuard): string {
  if (g.kind === "param-const") {
    return `c:${g.paramIndex}:${JSON.stringify(g.value)}`;
  }
  return `t:${g.paramIndex}:${g.ty.kinds}:${g.ty.intRef}:${g.ty.boolRef}:${g.ty.floatRef}`;
}

/** Canonical projected-guard key for backends that want to compare contexts by
 *  entry-specialization boundary rather than raw Context identity. */
export function guardKeyFor(
  unit: Unit,
  context: Context,
): string | undefined {
  const guards = entryGuardsFor(unit, context);
  if (guards === undefined) return undefined;
  return guards
    .map(encodeGuard)
    .sort()
    .join("|");
}
