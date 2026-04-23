// Speculation is a canonical finite partial map
// (Narrowing, Key) ⇀ Value, interned into a tree whose parent-edges
// follow a canonical sorted build order. The algebra on this structure
// lives in `assumption-algebra.ts` and reads the content-addressed
// `bindings` map; per-chain body storage lives in `assumption-bodies.ts`.
// This module defines the interface, the ROOT sentinel, and lifecycle
// helpers.

import type { Narrowing } from "./analysis";
import { defaultInterner } from "./assumption-chain-interner";

export interface Assumption<K = unknown, V = unknown> {
  readonly narrowing: Narrowing<K, V>;
  readonly key: K;
  readonly value: V;
}

/** Content-addressed binding map carried by every canonical chain. Built
 *  at intern-time as `parent.bindings` extended with the tip. Nested by
 *  narrowing first, then key, both compared by `===`. Consumers read it
 *  via `assumption-algebra.ts`. */
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

/** Shared prototype for all interned chain instances. Kept as a stable
 *  object so `Object.create(CHAIN_PROTO)` identifies interner-produced
 *  chains; has no methods (body storage is a free-function module now). */
export const CHAIN_PROTO: object = Object.freeze({});

const EMPTY_BINDINGS: BindingsByNarrowing = new Map();

export const ROOT_CONTEXT: Speculation = Object.freeze(
  Object.assign(Object.create(CHAIN_PROTO), {
    parent: undefined,
    assumption: undefined,
    depth: 0,
    bindings: EMPTY_BINDINGS,
  }) as Speculation,
);

export function isRoot(ctx: Speculation): boolean {
  return ctx.parent === undefined;
}

/** Remove `ctx` from the process-wide interner. ROOT is a no-op. */
export function releaseChain(ctx: Speculation): void {
  defaultInterner.release(ctx);
}
