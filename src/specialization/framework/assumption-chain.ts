// Speculation: canonical finite partial map (Narrowing, Key) ⇀ Value,
// interned into a trie by the default interner. Algebra is in
// `assumption-algebra.ts`; per-chain body storage in `assumption-bodies.ts`.

import type { Narrowing } from "./analysis";
import { defaultInterner } from "./assumption-chain-interner";

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

export interface Speculation {
  readonly parent: Speculation | undefined;
  readonly assumption: Assumption | undefined;
  readonly depth: number;
  readonly bindings: BindingsByNarrowing;
}

export const ROOT_CONTEXT: Speculation = Object.freeze({
  parent: undefined,
  assumption: undefined,
  depth: 0,
  bindings: new Map() as BindingsByNarrowing,
});

export function isRoot(ctx: Speculation): boolean {
  return ctx.parent === undefined;
}

/** Remove `ctx` from the process-wide interner. ROOT is a no-op. */
export function releaseChain(ctx: Speculation): void {
  defaultInterner.release(ctx);
}
