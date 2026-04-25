import type { FunctionId } from "../program/views/function-view";

/** Function-entry parameter identity, encoded as `${functionId}:${paramIndex}`
 *  so it is usable directly as an AssumptionChain / observation key.
 *
 *  This is not a NodeSet and not an analysis key: it identifies a runtime
 *  parameter observation axis. The corresponding owning function is recovered
 *  from the encoded FunctionId by the param observation binding. */
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
