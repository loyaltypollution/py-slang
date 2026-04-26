import { StmtNS } from "../../ast-types";
import { at, type AssumptionChain, isRoot } from "../assumption";
import type { Function } from "../program/function/function";
import { paramKey, paramKeyIndex, type ParamKey } from "./param-key";
import { paramTypeNarrowing } from "./param-handles";
import { returnKindNarrowing, type TypeLattice } from "../analysis";

type EntryGuard = { paramIndex: number; ty: TypeLattice };

export function directParamEntryGuardsFor(
  function: Function,
  context: AssumptionChain,
): readonly EntryGuard[] | undefined {
  if (!(function.funcAst instanceof StmtNS.FunctionDef)) return undefined;
  const guards: EntryGuard[] = [];
  for (let i = 0; i < function.funcAst.parameters.length; i++) {
    const key = paramKey(function.funcAst.id, i);
    const ty = at(context, paramTypeNarrowing, key);
    if (ty !== undefined) guards.push({ paramIndex: i, ty });
  }
  return guards.length > 0 ? guards : undefined;
}

export function contextIsEntrySpecializable(function: Function, context: AssumptionChain): boolean {
  if (!(function.funcAst instanceof StmtNS.FunctionDef)) return false;
  for (let cur: AssumptionChain = context; !isRoot(cur); cur = cur.parent) {
    const a = cur.assumption;
    if (a.narrowing === paramTypeNarrowing) {
      const index = paramKeyIndex(a.key as ParamKey);
      if (index >= 0 && index < function.funcAst.parameters.length) continue;
    }
    if (a.narrowing === returnKindNarrowing) continue;
    return false;
  }
  return true;
}

export function guardKeyFromGuards(
  guards: readonly EntryGuard[] | undefined,
): string | undefined {
  if (guards === undefined) return undefined;
  return guards
    .map(g => `t:${g.paramIndex}:${g.ty.kinds}:${g.ty.intRef}:${g.ty.boolRef}:${g.ty.floatRef}`)
    .join("|");
}
