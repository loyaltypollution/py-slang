// Block-level purity fact for intraprocedural MOD dataflow.
//   mod      — slots (envLevel 0) possibly written on this path
//   calls    — worst observed call purity (clean | whitelisted | impure)
//   impure   — sticky disqualifying flag (aliasing stores, assert, nonlocal/global, lambda, list alloc, etc.)

export type CallPurity = "clean" | "whitelisted" | "impure";

const CLEAN: CallPurity = "clean";
export const WHITELISTED: CallPurity = "whitelisted";
export const IMPURE_CALL: CallPurity = "impure";

export interface PurityRecord {
  readonly mod: ReadonlySet<number>;
  readonly calls: CallPurity;
  readonly impure: boolean;
}

const EMPTY_SET: ReadonlySet<number> = new Set();

export const BOTTOM_FACT: PurityRecord = Object.freeze({
  mod: EMPTY_SET,
  calls: CLEAN,
  impure: false,
});

function joinCallPurity(a: CallPurity, b: CallPurity): CallPurity {
  if (a === IMPURE_CALL || b === IMPURE_CALL) return IMPURE_CALL;
  if (a === WHITELISTED || b === WHITELISTED) return WHITELISTED;
  return CLEAN;
}

export function joinFact(a: PurityRecord, b: PurityRecord): PurityRecord {
  if (a === b) return a;
  const mod = unionSet(a.mod, b.mod);
  return {
    mod,
    calls: joinCallPurity(a.calls, b.calls),
    impure: a.impure || b.impure,
  };
}

export function factEquals(a: PurityRecord, b: PurityRecord): boolean {
  if (a === b) return true;
  if (a.calls !== b.calls) return false;
  if (a.impure !== b.impure) return false;
  return setEquals(a.mod, b.mod);
}

export function addMod(fact: PurityRecord, slot: number): PurityRecord {
  if (fact.mod.has(slot)) return fact;
  const mod = new Set(fact.mod);
  mod.add(slot);
  return { ...fact, mod };
}

export function markImpure(fact: PurityRecord): PurityRecord {
  if (fact.impure) return fact;
  return { ...fact, impure: true };
}

export function bumpCalls(fact: PurityRecord, call: CallPurity): PurityRecord {
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
