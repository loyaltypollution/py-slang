import type { FunctionId } from "../program/views/function";

/** Function-entry parameter identity, encoded as `${functionId}:${paramIndex}`
 *  so it is usable directly as an AssumptionChain / observation key.
 *
 *  Boundary key — paired with FunctionId at the runtime/observation surface.
 *  Not a NodeSet, not an analysis key, not a structural relation inside the
 *  IR. The owning function is recovered from the encoded FunctionId by the
 *  param observation binding. Do not migrate to a `Function` reference: the
 *  encoding has to survive across observation channels and AssumptionChain
 *  bindings whose stable identity is the whole point. */
export type ParamKey = `${FunctionId}:${number}`;

export function paramKey(functionId: FunctionId, paramIndex: number): ParamKey {
  return `${functionId}:${paramIndex}`;
}

export function paramKeyFunctionId(key: ParamKey): FunctionId {
  return Number(key.slice(0, key.indexOf(":")));
}

export function paramKeyIndex(key: ParamKey): number {
  return Number(key.slice(key.indexOf(":") + 1));
}
