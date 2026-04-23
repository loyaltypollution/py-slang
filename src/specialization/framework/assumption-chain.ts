// AssumptionChain is a path of assumptions through an immutable tree.
// Root = ∅ = "assume nothing." A child extends its parent with a single
// assumption of the form "for narrowing N, key K, the assumed value is V".
// Transfer functions running under a non-root Assumption meet their computed fact
// with any ancestor assumption that applies to the (narrowing, key) being
// computed.
//
// Operations on AssumptionChain are navigational and publication-oriented
// (parent, depth, findAssumption, visibleBody, forkBody) — never
// lattice-valued (join, meet), and no longer the fact read surface.
// Two chains are not combined. Siblings represent independent speculations;
// a path from root to a leaf is the chain one compiled version depends on.

import type { StmtNS } from "../../ast-types";
import type { Narrowing } from "./analysis";
import { cloneStmts } from "./ast-deep-clone";
import { defaultInterner } from "./assumption-chain-interner";
import type { Unit } from "./function-unit";

export interface Assumption<K = unknown, V = unknown> {
  readonly narrowing: Narrowing<K, V>;
  readonly key: K;
  readonly value: V;
}

/** Reading/mutation surface for bodies under this chain.
 *
 *  Body ownership follows the capability story: callers read the body
 *  visible at a chain via `visibleBody(unit)` and publish rewrites via
 *  `forkBody(unit)`. The per-(Unit, AssumptionChain) storage backing those
 *  operations is private to this module.
 *
 *  Fact reads no longer live here; they are exposed on the owning
 *  `Analysis`/analysis-view object so the key type stays tied to the
 *  analysis topology. */
export interface AssumptionChain {
  readonly parent: AssumptionChain | undefined;
  readonly assumption: Assumption | undefined;
  readonly depth: number;
  /** Return the body array visible to work running under this chain.
   *  Walks `this → ROOT`; the nearest owning chain node wins. Under
   *  `ROOT_CONTEXT` the returned array IS `unit.funcAst.body`. */
  visibleBody(unit: Unit): readonly StmtNS.Stmt[];
  /** Materialize a forked body for `unit` at this chain. When multiple
   *  rules fire at the same chain they all mutate the same forked body.
   *  Under `ROOT_CONTEXT` the returned array IS `unit.funcAst.body`. */
  forkBody(unit: Unit): StmtNS.Stmt[];
}

/** Per-unit map from non-ROOT chain node to its forked body. ROOT is never
 *  a key: `visibleBody` falls through to `unit.funcAst.body` when the walk
 *  hits ROOT without finding an entry. */
const bodies: WeakMap<Unit, Map<AssumptionChain, StmtNS.Stmt[]>> = new WeakMap();

function perUnit(unit: Unit): Map<AssumptionChain, StmtNS.Stmt[]> {
  let m = bodies.get(unit);
  if (m === undefined) {
    m = new Map();
    bodies.set(unit, m);
  }
  return m;
}

function visibleBodyInternal(unit: Unit, context: AssumptionChain): StmtNS.Stmt[] {
  if (context.parent === undefined) return unit.body;
  const m = bodies.get(unit);
  if (m !== undefined) {
    for (let cur: AssumptionChain | undefined = context; cur !== undefined; cur = cur.parent) {
      const owned = m.get(cur);
      if (owned !== undefined) return owned;
    }
  }
  return unit.body;
}

function forkBodyInternal(unit: Unit, context: AssumptionChain): StmtNS.Stmt[] {
  if (context.parent === undefined) return unit.body;
  const m = perUnit(unit);
  const existing = m.get(context);
  if (existing !== undefined) return existing;
  const fork = cloneStmts(visibleBodyInternal(unit, context));
  m.set(context, fork);
  return fork;
}

const chainProto = {
  visibleBody(this: AssumptionChain, unit: Unit): readonly StmtNS.Stmt[] {
    return visibleBodyInternal(unit, this);
  },
  forkBody(this: AssumptionChain, unit: Unit): StmtNS.Stmt[] {
    return forkBodyInternal(unit, this);
  },
};

/** Shared prototype for all interned chain instances. Exported for the
 *  interner; consumers should never touch it directly. */
export const CHAIN_PROTO: object = Object.freeze(chainProto);

export const ROOT_CONTEXT: AssumptionChain = Object.freeze(
  Object.assign(Object.create(CHAIN_PROTO), {
    parent: undefined,
    assumption: undefined,
    depth: 0,
  }) as AssumptionChain,
);

export function isRoot(ctx: AssumptionChain): boolean {
  return ctx.parent === undefined;
}

/** Build a canonical child context. Equivalent calls (same `parent`, same
 *  `(narrowing, key)`, and algebra-equal value) return the same object —
 *  identity is a sound proxy for structural equality. Value dedup uses the
 *  narrowing's value-equality relation, so no per-caller equality parameter
 *  is needed.
 *
 *  Chains are stored in canonical order by `(narrowing, key)`, so
 *  adding an assumption that sorts before an existing link triggers a
 *  silent rebuild — the returned chain may not have `parent` as its literal
 *  `.parent` pointer when the sort order requires insertion mid-chain. */
export function extendContext<K, V>(
  parent: AssumptionChain,
  narrowing: Narrowing<K, V>,
  key: K,
  value: V,
): AssumptionChain {
  return defaultInterner.extend(parent, narrowing, key, value);
}

/** Walk parent pointers looking for the chain node whose own tip
 *  assumption matches `(narrowing, key)`, and return that node. The
 *  canonical invariant guarantees at most one match. `findAssumption`
 *  projects the bound value; retirement uses the node identity itself. */
export function findAssumptionCarrier<K, V>(
  ctx: AssumptionChain,
  narrowing: Narrowing<K, V>,
  key: K,
): AssumptionChain | undefined {
  const target = narrowing as Narrowing<unknown, unknown>;
  for (let cur: AssumptionChain | undefined = ctx; cur !== undefined; cur = cur.parent) {
    const a = cur.assumption;
    if (a !== undefined && a.narrowing === target && a.key === key) return cur;
  }
  return undefined;
}

/** Walk parent pointers looking for an assumption bound against
 *  `(narrowing, key)`. Returns the deepest match (closest to `ctx`).
 *  `undefined` when no ancestor carries such an assumption. */
export function findAssumption<K, V>(
  ctx: AssumptionChain,
  narrowing: Narrowing<K, V>,
  key: K,
): V | undefined {
  return findAssumptionCarrier(ctx, narrowing, key)?.assumption?.value as V | undefined;
}

/** `anc` is an ancestor of `ctx` (or equal). O(depth). */
export function hasAncestor(ctx: AssumptionChain, anc: AssumptionChain): boolean {
  for (let cur: AssumptionChain | undefined = ctx; cur !== undefined; cur = cur.parent) {
    if (cur === anc) return true;
  }
  return false;
}

/** Return a context derived from `ctx` with every assumption at
 *  `(narrowing, key)` removed. Identity-returns `ctx` unchanged when no
 *  link matched — callers can short-circuit on reference equality. The
 *  canonical invariant guarantees at most one match (collisions at the
 *  same `(narrowing, key)` are replaced at extend-time, not layered), so
 *  "every" is 0 or 1 in practice — the wording is preserved for the
 *  historical contract. The returned chain is canonical; a prune that
 *  leaves a subset any prior compilation was built under returns the `===`
 *  pre-built sibling. */
export function excludeAssumption<K, V>(
  ctx: AssumptionChain,
  narrowing: Narrowing<K, V>,
  key: K,
): AssumptionChain {
  return defaultInterner.exclude(ctx, narrowing, key);
}

/** Remove `ctx` from the process-wide interner. See
 *  `ContextInterner.release` for the ownership contract — callers are
 *  responsible for ensuring nothing else holds the chain. ROOT is a silent
 *  no-op. */
export function releaseChain(ctx: AssumptionChain): void {
  defaultInterner.release(ctx);
}

/** Drop every forked body owned by `unit`. Called by the worklist when a
 *  unit retires or its CFG is rebuilt from scratch. */
export function clearUnitBodies(unit: Unit): void {
  bodies.delete(unit);
}

/** Drop the forked body at `context` for `unit`, if one exists. No-op at
 *  ROOT (which is never a key) or when `context` has no fork. Called by the
 *  worklist when speculation widens past `context` — the old chain node is
 *  no longer reachable from `futureDispatchContext`, and its forked tree is
 *  dead weight. Returns true iff an entry was dropped. */
export function clearBodyIfForked(unit: Unit, context: AssumptionChain): boolean {
  if (context.parent === undefined) return false;
  const m = bodies.get(unit);
  if (m === undefined) return false;
  return m.delete(context);
}
