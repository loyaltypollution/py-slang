// src/runtime/memo.ts
//
// Runtime side-table + intrinsic helpers backing MemoizationTransformRule.
// The transform rewrites hot function bodies to call three intrinsics
// (`__memo_has`, `__memo_get`, `__memo_put`); each engine adapts these to
// its builtin calling convention by calling the raw helpers below.
//
// Storage is module-global: a Map keyed on the mint id the transform emits
// (e.g. "fib@L3"), whose value is itself a Map keyed on a stringified arg
// tuple. That keeps the "minimal logic in the interpreter" contract —
// interpreters are not responsible for cache allocation or lifetime.

const MISS = Symbol("MEMO_MISS");

const cache = new Map<string, Map<string, unknown>>();

function argKey(args: readonly unknown[]): string {
  // \x1f separates arg positions; each component is tagged with its JS
  // `typeof` so that `[1]` and `["1"]` (and `[true]` vs `["true"]`, etc.)
  // do not collide in the cache.
  return args.map(a => `${typeof a}:${String(a)}`).join("\x1f");
}

/**
 * Look up a cached value. Returns the value on hit, `MEMO_MISS` on miss.
 * Callers compare against `MEMO_MISS` rather than calling a separate
 * `memoHas` then `memoGet` — one Map lookup, one comparison.
 */
export function memoLookup(id: string, args: readonly unknown[]): unknown {
  const inner = cache.get(id);
  if (!inner) return MISS;
  const key = argKey(args);
  if (!inner.has(key)) return MISS;
  return inner.get(key);
}

/** Stores `value` and returns it so call sites can chain through. */
export function memoPut(id: string, args: readonly unknown[], value: unknown): unknown {
  let inner = cache.get(id);
  if (!inner) {
    inner = new Map();
    cache.set(id, inner);
  }
  inner.set(argKey(args), value);
  return value;
}

/** Testing-only: drop all cached entries. */
export function clearMemoCache(): void {
  cache.clear();
}

/** Testing-only: expose the raw side-table (do not mutate externally). */
export function memoCacheSnapshot(): ReadonlyMap<string, ReadonlyMap<string, unknown>> {
  return cache;
}

export const MEMO_MISS = MISS;

/**
 * Names of the runtime intrinsics the transform emits. Consumed by the
 * resolver (to seed the global env) and by the CSE/SVML builtin registries
 * (to route calls). Single source of truth so the three sites cannot drift.
 *
 * Python-side intrinsics remain the two-call form `__memo_has` / `__memo_get`
 * / `__memo_put` — collapsing to a single `__memo_lookup` in the emitted
 * Python AST requires a Python-level identity for `MEMO_MISS` and is
 * deliberately deferred to a future step. The JS helper layer is already
 * collapsed: both intrinsics route through `memoLookup` internally.
 */
export const MEMO_INTRINSIC_NAMES = ["__memo_has", "__memo_get", "__memo_put"] as const;
