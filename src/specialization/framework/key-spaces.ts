/** Program-derived key spaces used by the specialization framework.
 *
 *  These are intentionally plain aliases of their runtime representation: the
 *  framework stores and compares the underlying values directly, but naming the
 *  spaces documents that `NodeId`, `FunctionId`, `BasicBlock`, and `Unit`
 *  are distinct index spaces even when some happen to be encoded as `number`.
 *
 *  Note on the Node/Function overlap: every `FunctionId` is, at runtime, the
 *  `.id` of a scope-owning AST node (FunctionDef or FileInput) — the same
 *  number you'd see as a `NodeId`. The two aliases route different semantic
 *  queries: `topology.unitOfNode(id)` returns the innermost unit whose CFG
 *  *contains* `id`, while `topology.unitOfFunctionId(id)` returns the unit
 *  whose scope node *is* identified by `id`. The distinction is semantic, not
 *  type-level; the alias exists so call sites read honestly. */

/** AST node id. Indexes individual expression/statement nodes. */
export type NodeId = number;

/** `FunctionDef.id` or `FileInput.id` — the node id of a scope-owning AST
 *  node whose optimization unit is registered with the topology. Same
 *  runtime representation as `NodeId`; the alias documents intent. */
export type FunctionId = number;

/** Function-entry parameter identity. Encoded as `${functionId}:${paramIndex}` so
 *  it is stable, comparable by value, and usable directly as a Context/store
 *  key without object-identity pitfalls. */
export type ParamKey = `${FunctionId}:${number}`;

export function paramKey(functionId: FunctionId, paramIndex: number): ParamKey {
  return `${functionId}:${paramIndex}`;
}

/** Interned `paramKey` strings, keyed by `FunctionId`. Hot-path callers
 *  (per-variable-visit in TypeAnalysisVisitor) index `paramKeysFor(fid, n)[slot]`
 *  instead of re-formatting the template literal on every visit.
 *
 *  A unit's parameter count is fixed at construction, but the cache grows the
 *  array if a later call requests a larger count (defensive — param counts
 *  never shrink in practice). */
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
