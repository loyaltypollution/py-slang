// Singleton `Pass<K, V>` factories for migrated analyses and transforms.
//
// Wiring:
//   - Node-keyed analyses (`typeAnalysisPass`, `constAnalysisPass`) are
//     populated by the analysis visitors writing directly through the
//     fact-store accessors in `fact-accessors.ts`.
//   - Scope-keyed passes (`purityScopePass`, `callCountPass`) keyed by
//     owning `FunctionDef.id`.
//   - Transforms (`deadBranchRule`, `constantFoldingRule`,
//     `memoizationRule`) are top-only `Pass<K, "fired">`. The top-only
//     `"fired"` lattice is the re-fire guard: once set, a re-write yields
//     `equals === true`, suppressing `onChange` and downstream wakes.

import { StmtNS } from "../../ast-types";
import { type ConstLattice, CONST_BOTTOM, constJoin } from "../const-analysis/lattice";
import { computePurity } from "../purity-analysis/analysis";
import { applyConstantFoldingSweep } from "../transforms/constant-folding";
import { applyDeadBranchSweep } from "../transforms/dead-branch";
import { applyMemoizationWrap } from "../transforms/memoization";
import { MEMOIZATION_THRESHOLD } from "../memoization-analysis/call-count";
import {
  type TypeLattice,
  BOTTOM as TYPE_BOTTOM,
  join as typeJoin,
} from "../type-analysis/lattice";
import type { FunctionUnit } from "./function-unit";
import type { Lattice, Pass, PassCtx } from "./pass";
import { runtimeCallPass, runtimeWritePass } from "./runtime-passes";
import { structuralPass } from "./structural-pass";

const typeLattice: Lattice<TypeLattice> = {
  bottom: TYPE_BOTTOM,
  equals: (a, b) =>
    a === b ||
    (a.kinds === b.kinds &&
      a.intRef === b.intRef &&
      a.boolRef === b.boolRef &&
      a.floatRef === b.floatRef),
  join: typeJoin,
};

// Transfer is a no-op: values are written directly by the analysis
// visitors via `writeTypeFact`; this pass exists as a Pass<K, V> handle so
// downstream readers can subscribe via the normal pass-graph mechanism.
export const typeAnalysisPass: Pass<number, TypeLattice> = {
  id: Symbol("typeAnalysisPass"),
  debugName: "typeAnalysisPass",
  lattice: typeLattice,
  reads: [runtimeWritePass, structuralPass],
  tier: "analysis",
  coarse: true,
  transfer(_ctx: PassCtx, _key: number): TypeLattice | undefined {
    return undefined;
  },
};

const constLattice: Lattice<ConstLattice> = {
  bottom: CONST_BOTTOM,
  equals: (a, b) =>
    a === b ||
    (a.tag !== "const"
      ? a.tag === b.tag
      : b.tag === "const" && a.value === b.value),
  join: constJoin,
};

export const constAnalysisPass: Pass<number, ConstLattice> = {
  id: Symbol("constAnalysisPass"),
  debugName: "constAnalysisPass",
  lattice: constLattice,
  reads: [runtimeWritePass, structuralPass],
  tier: "analysis",
  coarse: true,
  transfer(_ctx: PassCtx, _key: number): ConstLattice | undefined {
    return undefined;
  },
};

// Purity 3-point lattice: ⊥ = undefined, true, false, ⊤ = "contested".
// The `"contested"` sentinel is reachable only from the Pass-layer join;
// while `purityScopePass` is the sole writer, transfer returns boolean.
type PurityPoint = boolean | "contested" | undefined;

const purityLattice: Lattice<PurityPoint> = {
  bottom: undefined,
  equals: (a, b) => a === b,
  join: (a, b) => {
    if (a === undefined) return b;
    if (b === undefined) return a;
    if (a === "contested" || b === "contested") return "contested";
    if (a === b) return a;
    return "contested";
  },
};

// Key is the owning FunctionDef.id.
// Initial converge is primed from worklist.processTransform.
export const purityScopePass: Pass<number, PurityPoint> = {
  id: Symbol("purityScopePass"),
  debugName: "purityScopePass",
  lattice: purityLattice,
  reads: [structuralPass],
  tier: "analysis",
  coarse: false,
  affectedKeys(_ctx, triggerPass, triggerKey) {
    if (triggerPass === (structuralPass as Pass<any, any>)) {
      const fd = (triggerKey as FunctionUnit).funcAst;
      if (fd instanceof StmtNS.FunctionDef) return [fd.id];
    }
    return [];
  },
  transfer(ctx: PassCtx, key: number): PurityPoint {
    const units = ctx.readAll(structuralPass);
    for (const unit of units.keys()) {
      const u = unit as FunctionUnit;
      const fd = u.funcAst;
      if (fd instanceof StmtNS.FunctionDef && fd.id === key) {
        return computePurity(u);
      }
    }
    return undefined;
  },
};

// Saturating bucket: once SAT is written, equal writes suppress onChange,
// dissolving the legacy `hasNonMonotoneRule` re-fire path.
const CALL_COUNT_SAT = MEMOIZATION_THRESHOLD + 1;

const callCountLattice: Lattice<number | undefined> = {
  bottom: undefined,
  equals: (a, b) => a === b,
  join: (a, b) => {
    if (a === undefined) return b;
    if (b === undefined) return a;
    return Math.min(CALL_COUNT_SAT, Math.max(a, b));
  },
};

export const callCountPass: Pass<number, number | undefined> = {
  id: Symbol("callCountPass"),
  debugName: "callCountPass",
  lattice: callCountLattice,
  reads: [runtimeCallPass],
  tier: "analysis",
  affectedKeys(_ctx, triggerPass, triggerKey) {
    if (triggerPass === (runtimeCallPass as Pass<any, any>)) {
      return [triggerKey as number];
    }
    return [];
  },
  transfer(ctx: PassCtx, key: number): number | undefined {
    const raw = ctx.read(runtimeCallPass, key);
    return Math.min(CALL_COUNT_SAT, raw);
  },
};

type Fired = "fired" | undefined;

const firedLattice: Lattice<Fired> = {
  bottom: undefined,
  equals: (a, b) => a === b,
  join: (a, b) => (a ?? b),
};

// Unit-keyed sweep rule factory. Dead-branch and constant-folding share
// the same shape: run a sweep over `unit.body`, return the fired marker.
// The `constAnalysisPass` read is node-keyed; without a node→unit map in
// ctx, affectedKeys defers to the explicit seed from `processTransform`.
function unitSweepRule(
  name: string,
  sweep: (unit: FunctionUnit, factStore: import("./fact-store").FactStore) => boolean,
): Pass<FunctionUnit, Fired> {
  return {
    id: Symbol(name),
    debugName: name,
    lattice: firedLattice,
    reads: [constAnalysisPass, structuralPass],
    tier: "transform",
    affectedKeys(_ctx, triggerPass, triggerKey) {
      if (triggerPass === (structuralPass as Pass<any, any>)) {
        return [triggerKey as FunctionUnit];
      }
      return [];
    },
    transfer(ctx: PassCtx, key: FunctionUnit): Fired {
      if (!sweep(key, ctx.factStore)) return undefined;
      return "fired";
    },
  };
}

export const deadBranchRule = unitSweepRule("deadBranchRule", applyDeadBranchSweep);
export const constantFoldingRule = unitSweepRule(
  "constantFoldingRule",
  applyConstantFoldingSweep,
);

// Gated on callCount threshold and pure===true. Both reads are keyed by
// FunctionDef.id; affectedKeys fan-out would need an id→unit map, so we
// defer to the explicit seed from worklist.processTransform.
export const memoizationRule: Pass<FunctionUnit, Fired> = {
  id: Symbol("memoizationRule"),
  debugName: "memoizationRule",
  lattice: firedLattice,
  reads: [callCountPass, purityScopePass],
  tier: "transform",
  affectedKeys() {
    return [];
  },
  transfer(ctx: PassCtx, key: FunctionUnit): Fired {
    const fd = key.funcAst;
    if (!(fd instanceof StmtNS.FunctionDef)) return undefined;
    const count = ctx.read(callCountPass, fd.id);
    if (count === undefined || count < MEMOIZATION_THRESHOLD) return undefined;
    if (ctx.read(purityScopePass, fd.id) !== true) return undefined;
    if (!applyMemoizationWrap(key)) return undefined;
    return "fired";
  },
};
