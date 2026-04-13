// src/specialization/purity-analysis/lattice.ts
//
// Purity lattice for an intraprocedural MOD dataflow.
//
// A `PurityFact` is a *block-level* fact (not a per-slot lattice), so the
// purity analysis is not shaped like `AnalysisPass<L>` (see
// `docs/specialization-cleanup-plan.md` §E for why). It is driven by
// `PurityScopePass` walking the CFG directly and joining at merges.
//
// Fields:
//   - `mod`      — slot indices (envLevel 0, locals-incl.-params) that may be
//                  written on this path.
//   - `calls`    — worst call-purity observed on this path: CLEAN (no call),
//                  WHITELISTED (only memo-safe builtins), IMPURE (user fn or
//                  non-whitelisted builtin).
//   - `impure`   — sticky "definitely-disqualifying" flag. Set by
//                  subscript-stores (target may alias caller object),
//                  `assert` (can raise AssertionError), nonlocal/global
//                  reads or writes, `lambda` / `List` / nested `FunctionDef`
//                  / `Starred` / `Global` / `NonLocal` / `FromImport`. These
//                  are not expressible in structured sub-fields without an
//                  escape model this cycle declines to build.

export type CallPurity = "clean" | "whitelisted" | "impure";

export const CLEAN: CallPurity = "clean";
export const WHITELISTED: CallPurity = "whitelisted";
export const IMPURE_CALL: CallPurity = "impure";

export interface PurityFact {
  readonly mod: ReadonlySet<number>;
  readonly calls: CallPurity;
  readonly impure: boolean;
}

const EMPTY_SET: ReadonlySet<number> = new Set();

export const BOTTOM_FACT: PurityFact = Object.freeze({
  mod: EMPTY_SET,
  calls: CLEAN,
  impure: false,
});

export const PURE_FIELD = "pure" as const;

export function joinCallPurity(a: CallPurity, b: CallPurity): CallPurity {
  if (a === IMPURE_CALL || b === IMPURE_CALL) return IMPURE_CALL;
  if (a === WHITELISTED || b === WHITELISTED) return WHITELISTED;
  return CLEAN;
}

export function joinFact(a: PurityFact, b: PurityFact): PurityFact {
  if (a === b) return a;
  const mod = unionSet(a.mod, b.mod);
  return {
    mod,
    calls: joinCallPurity(a.calls, b.calls),
    impure: a.impure || b.impure,
  };
}

export function factEquals(a: PurityFact, b: PurityFact): boolean {
  if (a === b) return true;
  if (a.calls !== b.calls) return false;
  if (a.impure !== b.impure) return false;
  return setEquals(a.mod, b.mod);
}

export function addMod(fact: PurityFact, slot: number): PurityFact {
  if (fact.mod.has(slot)) return fact;
  const mod = new Set(fact.mod);
  mod.add(slot);
  return { ...fact, mod };
}

export function markImpure(fact: PurityFact): PurityFact {
  if (fact.impure) return fact;
  return { ...fact, impure: true };
}

export function bumpCalls(fact: PurityFact, call: CallPurity): PurityFact {
  const next = joinCallPurity(fact.calls, call);
  if (next === fact.calls) return fact;
  return { ...fact, calls: next };
}

function unionSet(a: ReadonlySet<number>, b: ReadonlySet<number>): ReadonlySet<number> {
  if (a === b) return a;
  if (a.size === 0) return b;
  if (b.size === 0) return a;
  const out = new Set<number>(a);
  for (const x of b) out.add(x);
  return out;
}

function setEquals(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
