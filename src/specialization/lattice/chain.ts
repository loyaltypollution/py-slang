// AssumptionChain: canonical finite partial map (Narrowing, Key) ⇀ Value,
// interned into a trie by the default interner. Algebra is in `./algebra`;
// per-chain body storage in `../assumption/assumption-bodies`.

import type { Narrowing } from "../framework/analysis";

export interface Assumption<K = unknown, V = unknown> {
  readonly narrowing: Narrowing<K, V>;
  readonly key: K;
  readonly value: V;
}

/** Content-addressed binding map carried by every canonical chain,
 *  nested by narrowing then key (both `===` compared). */
export type BindingsByNarrowing = ReadonlyMap<
  Narrowing<any, any>,
  ReadonlyMap<unknown, Assumption>
>;

export interface AssumptionChain {
  readonly parent: AssumptionChain | undefined;
  readonly assumption: Assumption | undefined;
  readonly depth: number;
  readonly bindings: BindingsByNarrowing;
}

export const ROOT_CONTEXT: AssumptionChain = Object.freeze({
  parent: undefined,
  assumption: undefined,
  depth: 0,
  bindings: new Map() as BindingsByNarrowing,
});

export function isRoot(ctx: AssumptionChain): boolean {
  return ctx.parent === undefined;
}
