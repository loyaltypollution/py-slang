// Entry-guard projection: the subset of (unit, Speculation) assumptions
// that are checkable at function entry. Used by dispatch to admit/reject
// a unit as entry-specializable, and by `memoization` to key variant
// caches on param-type observations.
//
// Projection source: direct function-entry parameter type observations,
// keyed by `ParamKey`. `returnKindNarrowing` assumptions remain chain-
// visible and still pass `contextIsEntrySpecializable` because they lower
// to entry-block type requirements via `requirementAtEntry`.

import { StmtNS } from "../ast-types";
import { isRoot, type Speculation } from "./framework/assumption-chain";
import { at } from "./framework/assumption-algebra";
import type { Unit } from "./framework/function-unit";
import {
  paramKey,
  paramKeyIndex,
  type ParamKey,
} from "./framework/key-spaces";
import { paramTypeNarrowing } from "./framework/param-handles";
import type { TypeLattice } from "./type-analysis/lattice";
import { returnKindNarrowing } from "./type-requirement-analysis/analysis";

export type EntryGuard = { paramIndex: number; ty: TypeLattice };

export function directParamEntryGuardsFor(
  unit: Unit,
  context: Speculation,
): readonly EntryGuard[] | undefined {
  if (!(unit.funcAst instanceof StmtNS.FunctionDef)) return undefined;
  const guards: EntryGuard[] = [];
  for (let i = 0; i < unit.funcAst.parameters.length; i++) {
    const key = paramKey(unit.funcAst.id, i);
    const ty = at(context, paramTypeNarrowing, key);
    if (ty !== undefined) guards.push({ paramIndex: i, ty });
  }
  return guards.length > 0 ? guards : undefined;
}

export function contextIsEntrySpecializable(unit: Unit, context: Speculation): boolean {
  if (!(unit.funcAst instanceof StmtNS.FunctionDef)) return false;
  for (let cur: Speculation | undefined = context; cur !== undefined && !isRoot(cur); cur = cur.parent) {
    const a = cur.assumption;
    if (a === undefined) continue;
    if (a.narrowing === paramTypeNarrowing) {
      const index = paramKeyIndex(a.key as ParamKey);
      if (index >= 0 && index < unit.funcAst.parameters.length) continue;
    }
    // returnKindNarrowing assumptions lower to entry-block type requirements
    // via `requirementAtEntry`; they are entry-specializable even though
    // they don't directly name a param slot.
    if (a.narrowing === returnKindNarrowing) continue;
    return false;
  }
  return true;
}

/** Canonical string key over the direct-param entry guards. Used by
 *  memoization to bucket per param-type variant. Returns `undefined` when
 *  no direct-param guards apply. Guards are produced in ascending
 *  `paramIndex` order, so canonical order is the iteration order. */
export function guardKeyFromGuards(
  guards: readonly EntryGuard[] | undefined,
): string | undefined {
  if (guards === undefined) return undefined;
  let out = "";
  for (let i = 0; i < guards.length; i++) {
    const g = guards[i];
    if (i > 0) out += "|";
    out += `t:${g.paramIndex}:${g.ty.kinds}:${g.ty.intRef}:${g.ty.boolRef}:${g.ty.floatRef}`;
  }
  return out;
}
