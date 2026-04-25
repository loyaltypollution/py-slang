export interface NarrowingId<K = unknown, V = unknown> {
  eq(a: V, b: V): boolean;
  readonly __narrowingBrand?: () => readonly [K, V];
}

export interface Assumption<K = unknown, V = unknown> {
  readonly narrowing: NarrowingId<K, V>;
  readonly key: K;
  readonly value: V;
}

export interface AssumptionChain {
  readonly parent: AssumptionChain | undefined;
  readonly assumption: Assumption | undefined;
  readonly depth: number;
  readonly bindings: ReadonlyMap<NarrowingId<any, any>, ReadonlyMap<unknown, Assumption>>;
}

export const ROOT_CONTEXT: AssumptionChain = Object.freeze({
  parent: undefined,
  assumption: undefined,
  depth: 0,
  bindings: new Map(),
});

export function isRoot(ctx: AssumptionChain): boolean {
  return ctx.parent === undefined;
}
