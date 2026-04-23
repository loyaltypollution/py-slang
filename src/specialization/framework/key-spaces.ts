/** Program-derived key spaces. Plain aliases of their runtime
 *  representation — naming documents that `NodeId`, `FunctionId`, etc. are
 *  distinct index spaces even when encoded as `number`.
 *
 *  Note on Node/Function overlap: every `FunctionId` is the `.id` of a
 *  scope-owning AST node. `topology.unitOfNode(id)` returns the innermost
 *  unit whose CFG contains `id`; `topology.unitOfFunctionId(id)` returns
 *  the unit whose scope node *is* `id`. Distinction is semantic. */

/** AST node id. Indexes individual expression/statement nodes. */
export type NodeId = number;

/** `FunctionDef.id` or `FileInput.id` — node id of a scope-owning AST node
 *  whose optimization unit is registered with the topology. */
export type FunctionId = number;

/** Function-entry parameter identity, encoded as `${functionId}:${paramIndex}`
 *  so it is stable and usable directly as a Context/store key. */
export type ParamKey = `${FunctionId}:${number}`;

export function paramKey(functionId: FunctionId, paramIndex: number): ParamKey {
  return `${functionId}:${paramIndex}`;
}

/** Interned `paramKey` strings, keyed by `FunctionId`. Hot-path callers
 *  index `paramKeysFor(fid, n)[slot]` instead of re-formatting on every
 *  visit. Grows the array if a later call requests a larger count. */
const PARAM_KEYS_CACHE = new Map<FunctionId, ParamKey[]>();

export function paramKeysFor(functionId: FunctionId, paramCount: number): readonly ParamKey[] {
  let arr = PARAM_KEYS_CACHE.get(functionId);
  if (arr === undefined) {
    arr = [];
    PARAM_KEYS_CACHE.set(functionId, arr);
  }
  for (let i = arr.length; i < paramCount; i++) {
    arr.push(`${functionId}:${i}` as ParamKey);
  }
  return arr;
}

export function paramKeyFunctionId(key: ParamKey): FunctionId {
  return Number(key.slice(0, key.indexOf(":")));
}

export function paramKeyIndex(key: ParamKey): number {
  return Number(key.slice(key.indexOf(":") + 1));
}
