// Per-(Unit, AssumptionChain) body storage — the physical realization of
// "each chain node owns its own AST."
//
// Layout: ROOT always "owns" a body via `unit.funcAst.body`. Non-ROOT chain
// nodes own a body only once a transform actually mutates there (lazy
// fork). `bodyFor(unit, context)` walks `context → ROOT` until it finds an
// owned body and returns it; `forkBodyAt(unit, context)` materializes a
// DEEP-cloned fork at `context` (from the body currently visible at that
// chain node) and returns the fresh tree for in-place mutation.
//
// Deep-fork rationale: transforms mutate AST shape at arbitrary depth
// (nested If bodies, expression operands). A shallow top-array clone
// would let deep mutations bleed onto the shared ancestor tree. Deep-fork
// is a one-shot structural clone per chain node; under the param-only
// narrowing policy, chain width per unit is small so the clone cost is
// bounded.
//
// Identity invariant: two chain nodes share a body array iff neither has
// forked. Descendants inherit via chain walk, not array identity — a fork
// at context C does not re-parent descendants; they continue to see C's
// fork on their next `bodyFor` call by virtue of C being their nearest
// owning ancestor.
//
// The store is keyed by (Unit, AssumptionChain). Unit retires clear the
// unit's entries; context lifecycle (canonical interning means contexts
// outlive any one compile) does not trigger clears on its own.

import type { StmtNS } from "../../ast-types";
import { ROOT_CONTEXT, type AssumptionChain } from "./context";
import type { Unit } from "./function-unit";
import { cloneStmts } from "./ast-deep-clone";

/** Per-unit map from non-ROOT chain node to its forked body. ROOT is never
 *  a key: `bodyFor` falls through to `unit.funcAst.body` when the walk hits
 *  ROOT without finding an entry. */
const bodies: WeakMap<Unit, Map<AssumptionChain, StmtNS.Stmt[]>> = new WeakMap();

function perUnit(unit: Unit): Map<AssumptionChain, StmtNS.Stmt[]> {
  let m = bodies.get(unit);
  if (m === undefined) {
    m = new Map();
    bodies.set(unit, m);
  }
  return m;
}

/** Return the body array seen by a compile/transform operating at
 *  `context`. Walks `context → ROOT`; the first owning chain node wins.
 *  ROOT's body is the canonical `unit.funcAst.body`, so the walk always
 *  terminates with a concrete array. */
export function bodyFor(unit: Unit, context: AssumptionChain): StmtNS.Stmt[] {
  if (context === ROOT_CONTEXT) return unit.body;
  const m = bodies.get(unit);
  if (m !== undefined) {
    for (let cur: AssumptionChain | undefined = context; cur !== undefined; cur = cur.parent) {
      const owned = m.get(cur);
      if (owned !== undefined) return owned;
    }
  }
  return unit.body;
}

/** Materialize a forked body at `context`. If `context` already owns a
 *  body, returns it unchanged (mutations accumulate on the existing fork).
 *  Otherwise deep-clones the tree currently visible at `context` (via
 *  `bodyFor`) and installs the clone as `context`'s owned body.
 *
 *  The clone is structural: every `StmtNS.*` and `ExprNS.*` node is
 *  recreated under its own prototype with its `id` preserved. Tokens and
 *  other value-typed fields are shared by reference. Transforms may then
 *  freely mutate the returned tree in place without affecting the
 *  ancestor's body. */
export function forkBodyAt(unit: Unit, context: AssumptionChain): StmtNS.Stmt[] {
  if (context === ROOT_CONTEXT) return unit.body;
  const m = perUnit(unit);
  const existing = m.get(context);
  if (existing !== undefined) return existing;
  const ancestor = bodyFor(unit, context);
  const fork = cloneStmts(ancestor);
  m.set(context, fork);
  return fork;
}

/** True iff `context` (non-ROOT) has a forked body installed. Intended for
 *  tests and debug tooling; normal consumers go through `bodyFor`. */
export function hasForkedBodyAt(unit: Unit, context: AssumptionChain): boolean {
  if (context === ROOT_CONTEXT) return true;
  const m = bodies.get(unit);
  return m !== undefined && m.has(context);
}

/** Drop every forked body owned by `unit`. Called by the worklist when a
 *  unit retires or its CFG is rebuilt from scratch. */
export function clearUnitBodies(unit: Unit): void {
  bodies.delete(unit);
}
