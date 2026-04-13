// src/specialization/framework/migrated-passes.ts
//
// Singleton `Pass<K, V>` factories for the analyses and transforms
// migrated in PR-4. Each pass conforms to the `Pass<K, V>` shape declared
// in `./pass.ts` and ships alongside the legacy `AnalysisPass` /
// `ScopePass` / `TransformRule` implementations that currently drive
// production (see PR-4 "also-driven-by-legacy" note).
//
// Wiring rules for PR-4:
//   - Node-keyed analysis passes (`typeAnalysisPass`, `constAnalysisPass`)
//     *back* the corresponding `OptimizationHint` field in `HintStore` —
//     hint-passes.ts no longer allocates a separate cell for `type` or
//     `constVal`; every `hints.updateField(id, "type", v)` routes to the
//     migrated pass's fact cell.
//   - Scope-keyed passes (`purityScopePass`, `callCountPass`) likewise
//     back `pure` / `callCount`, keyed by the `FunctionDef.id` of the
//     owning scope (identical to what the legacy `ScopePass.run` wrote).
//   - Transforms (`deadBranchRule`, `constantFoldingRule`,
//     `memoizationRule`) are top-only `Pass<K, "fired">`. Their `transfer`
//     is a no-op in PR-4 — legacy dispatch applies them; the Pass is
//     registered so the graph has visibility and PR-5+ can migrate.
//
// Side-effect idempotence rule (plan review resolution 3): each transform
// writes `"fired"` exactly once per (rule, key) pair — top-only lattice
// means a re-write produces no `onChange` event, so any side effects in
// `transfer` would be suppressed on re-enqueue. Documented per-pass.

import { StmtNS } from "../../ast-types";
import {
  type ConstLattice,
  CONST_BOTTOM,
  CONST_TOP,
  constJoin,
  constLeq,
} from "../const-analysis/lattice";
import { computePurity } from "../purity-analysis/analysis";
import { applyConstantFoldingSweep } from "../transforms/constant-folding";
import { applyDeadBranchSweep } from "../transforms/dead-branch";
import {
  type TypeLattice,
  BOTTOM as TYPE_BOTTOM,
  TOP as TYPE_TOP,
  join as typeJoin,
  leq as typeLeq,
} from "../type-analysis/lattice";
import type { FunctionUnit } from "./function-unit";
import type { Lattice, Pass, PassCtx } from "./pass";
import { runtimeCallPass, runtimeWritePass } from "./runtime-passes";
import { structuralPass } from "./structural-pass";

// ── Type lattice helpers ────────────────────────────────────────────────

const typeEquals = (a: TypeLattice, b: TypeLattice): boolean =>
  a === b ||
  (a.kinds === b.kinds &&
    a.intRef === b.intRef &&
    a.boolRef === b.boolRef &&
    a.floatRef === b.floatRef);

const typeLattice: Lattice<TypeLattice> = {
  bottom: TYPE_BOTTOM,
  equals: typeEquals,
  join: typeJoin,
};

/**
 * Migrated type analysis (node-keyed). Written through by
 * `HintStore.updateField(id, "type", v)` — see `hint-passes.ts`. `reads`
 * declare the source passes that a future dispatch-driven transfer would
 * consult; PR-4 keeps `transfer` a no-op because legacy DFA drives values.
 */
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

// ── Const lattice helpers ───────────────────────────────────────────────

const constEqualsPassShape = (a: ConstLattice, b: ConstLattice): boolean =>
  a === b ||
  (a.tag !== "const"
    ? a.tag === b.tag
    : b.tag === "const" && a.value === b.value);

const constLattice: Lattice<ConstLattice> = {
  bottom: CONST_BOTTOM,
  equals: constEqualsPassShape,
  join: constJoin,
};
// Keep unused import suppressors alive for future PR-5 transfer bodies.
void constLeq;
void typeLeq;
void CONST_TOP;
void TYPE_TOP;

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

// ── Purity: 3-point flat bool lattice ───────────────────────────────────
//
// Plan-specified domain: `⊥ = unanalyzed (undefined) | true | false | ⊤
// = contested`. `equals` is `===`; `join(⊥, x) = x`, `join(⊤, x) = ⊤`,
// `join(true, false) = ⊤`. Legacy `PurityScopePass.run` only ever writes
// boolean values via `HintStore.updateField(id, "pure", v)`, so the
// `"contested"` sentinel is reachable only from the Pass-layer join —
// distinguishable from `true`/`false` but identical to `boolean`-typed
// `OptimizationHint.pure` at the hint surface (tests read booleans, the
// sentinel never escapes).

export type PurityPoint = boolean | "contested" | undefined;

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

/**
 * Migrated purity (scope-keyed, PR-6a end-to-end). Key is the owning
 * `FunctionDef.id` (number) so that `HintStore.updateField(id, "pure", v)`
 * routes to the same `(pass, key)` cell the transfer writes — consumers
 * reading `hintsFor(fd).pure` see the value produced by this transfer
 * with no adapter layer.
 *
 * Scheduling: `reads = [structuralPass]` — the single declared input.
 * After a CFG rebuild the worklist's `handleFactChange` enqueues this
 * pass for the unit's id via `affectedKeys`. The initial converge is
 * primed from `processTransform` (see worklist.ts), matching the
 * pre-PR-6a timing where `PurityScopePass.run` was invoked at the end
 * of each scope's convergence round.
 *
 * Transfer: delegates to `computePurity(unit)` — the CFG-walking fixpoint
 * lifted out of the deleted `PurityScopePass` class. Pure boolean output;
 * the `"contested"` join sentinel is unreachable while this pass is the
 * sole writer of its cell.
 */
export const purityScopePass: Pass<number, PurityPoint> = {
  id: Symbol("purityScopePass"),
  debugName: "purityScopePass",
  lattice: purityLattice,
  reads: [structuralPass],
  tier: "analysis",
  coarse: false,
  // Map a structuralPass write for unit U to this pass's key = U.funcAst.id.
  // Unknown trigger → no keys (prevents accidental fan-out from unrelated
  // writes that might later share the `reads` list).
  affectedKeys(triggerPass, triggerKey) {
    if (triggerPass === (structuralPass as Pass<any, any>)) {
      const unit = triggerKey as FunctionUnit;
      const fd = unit.funcAst;
      if (fd instanceof StmtNS.FunctionDef) return [fd.id];
    }
    return [];
  },
  transfer(ctx: PassCtx, key: number): PurityPoint {
    // Find the unit whose FunctionDef.id matches `key`. The structuralPass
    // readAll yields the registered units (one write per rebuildStructural
    // call); initial-converge primes this pass directly with the unit's id
    // (see worklist.processTransform) so the readAll set is populated by
    // the time transfer fires post-rebuild.
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

// ── callCount: saturating bucket ────────────────────────────────────────

const CALL_COUNT_SAT = 11; // MEMOIZATION_THRESHOLD + 1

const callCountLattice: Lattice<number | undefined> = {
  bottom: undefined,
  equals: (a, b) => a === b,
  join: (a, b) => {
    if (a === undefined) return b;
    if (b === undefined) return a;
    return Math.min(CALL_COUNT_SAT, Math.max(a, b));
  },
};

/**
 * Migrated call count (scope-keyed). Saturating bucket: once SAT is
 * written, every further write produces `lattice.equals === true` and no
 * consumer wakes — this is the mechanism that dissolves the legacy
 * `hasNonMonotoneRule` flag once PR-5 wires `runtimeCallPass`. For PR-4,
 * keyed by node id to stay byte-identical with the HintStore route.
 */
export const callCountPass: Pass<number, number | undefined> = {
  id: Symbol("callCountPass"),
  debugName: "callCountPass",
  lattice: callCountLattice,
  reads: [runtimeCallPass],
  tier: "analysis",
  // Precise affectedKeys: a runtimeCallPass write for scope-id S enqueues
  // callCountPass for the same id. This also primes the pass on the very
  // first observation (coarse:true would yield no keys before any write).
  affectedKeys(triggerPass, triggerKey) {
    if (triggerPass === (runtimeCallPass as Pass<any, any>)) {
      return [triggerKey as number];
    }
    return [];
  },
  /**
   * Saturating-bucket transfer (PR-5). Reads the raw count from
   * `runtimeCallPass`, clamps to `[0, MEMOIZATION_THRESHOLD + 1]`. Once
   * `CALL_COUNT_SAT` is written, every subsequent transfer produces the
   * same value → `lattice.equals` suppresses `onChange` → `memoizationRule`
   * and `jitPass` are not re-enqueued past saturation. This is the
   * structural fix for the legacy "callCount++ triggers full recompile"
   * bug — the global `hasNonMonotoneRule` gate becomes redundant.
   */
  transfer(ctx: PassCtx, key: number): number | undefined {
    const raw = ctx.read(runtimeCallPass, key);
    return Math.min(CALL_COUNT_SAT, raw);
  },
};

// ── Transforms: top-only `"fired"` lattice ──────────────────────────────

type Fired = "fired" | undefined;

const firedLattice: Lattice<Fired> = {
  bottom: undefined,
  equals: (a, b) => a === b,
  join: (a, b) => (a ?? b),
};

/**
 * Dead-branch elimination (PR-6c end-to-end). Top-only
 * `Pass<FunctionUnit, "fired">`. Transfer sweeps `unit.body` for `If`
 * statements with a statically-known boolean condition and splices them
 * out in place (see `applyDeadBranchSweep`).
 *
 * Idempotence (two-layer):
 *  1. AST-level — the `StmtNS.If` match predicate returns false once the
 *     `If` node has been spliced out of its containing block, so a second
 *     sweep on an already-converged body mutates nothing.
 *  2. Lattice-level — the top-only `"fired"` lattice: rewriting `"fired"`
 *     on a key that already holds `"fired"` yields `lattice.equals ===
 *     true`, suppressing `onChange` and preventing spurious downstream
 *     wakes.
 *
 * Scheduling: `reads = [constAnalysisPass, structuralPass]`. Legacy const
 * analysis writes land through the PR-3 adapter into `constAnalysisPass`'s
 * fact cell and wake this pass through the dispatch graph (the adapter
 * is how const facts reach the new driver before PR-6d migrates const).
 * An initial-converge seed is primed from `worklist.processTransform`
 * (mirroring the PR-6a purity seeding).
 *
 * Side effects: the transfer mutates `unit.body` and bumps
 * `unit.structuralVersion` on fire; the worklist's `processTransform`
 * reacts to the version delta by setting `anyChanged = true`, which in
 * turn marks the scope `"structural"` dirty and rebuilds the CFG on the
 * next drain iteration.
 */
export const deadBranchRule: Pass<FunctionUnit, Fired> = {
  id: Symbol("deadBranchRule"),
  debugName: "deadBranchRule",
  lattice: firedLattice,
  reads: [constAnalysisPass, structuralPass],
  tier: "transform",
  // Precise affectedKeys: any upstream write for unit U enqueues this
  // pass for U. `structuralPass` is keyed by `FunctionUnit` directly;
  // `constAnalysisPass` is node-keyed — for coarse routing we re-run on
  // all previously-written keys in that case, which matches the legacy
  // "every transform round re-sweeps every unit" semantics.
  affectedKeys(triggerPass, triggerKey) {
    if (triggerPass === (structuralPass as Pass<any, any>)) {
      return [triggerKey as FunctionUnit];
    }
    // constAnalysisPass: node-keyed. Without a node-id → owning-unit
    // map in ctx we fall back to coarse re-run via returning the empty
    // iterable here and relying on the worklist's explicit seed in
    // `processTransform` to re-drive the sweep each round. That seed is
    // the canonical trigger this PR; this branch is reserved for PR-6d
    // once const is migrated and can fan out to its owning unit.
    return [];
  },
  transfer(_ctx: PassCtx, key: FunctionUnit): Fired {
    const fired = applyDeadBranchSweep(key);
    if (fired) {
      // Side-channel structural bump: the sweep mutated `key.body`, so
      // CFG must be rebuilt. The worklist's `processTransform` reads
      // `unit.structuralVersion` before/after `drainPasses()` and sets
      // `anyChanged = true` on delta, triggering the usual
      // markDirty("structural") → rebuildStructural path.
      key.structuralVersion++;
      return "fired";
    }
    return undefined;
  },
};

/**
 * Constant folding (PR-6d end-to-end). Top-only
 * `Pass<FunctionUnit, "fired">`. Transfer sweeps `unit.body` for
 * Binary/Compare expressions whose `constVal` hint has collapsed to a
 * statically-known constant and rewrites them in place to `Literal`
 * nodes (see `applyConstantFoldingSweep`).
 *
 * Idempotence (two-layer):
 *  1. AST-level — once a Binary/Compare has been rewritten to a
 *     `Literal`, the `matchesExpr` predicate returns false on the
 *     replacement node, so a second sweep over an already-folded body
 *     mutates nothing.
 *  2. Lattice-level — the top-only `"fired"` lattice: rewriting `"fired"`
 *     on a key that already holds `"fired"` yields `lattice.equals ===
 *     true`, suppressing `onChange` and preventing spurious downstream
 *     wakes.
 *
 * Scheduling: `reads = [constAnalysisPass, structuralPass]`. Same story
 * as `deadBranchRule` — legacy const analysis writes land through the
 * PR-3 adapter into `constAnalysisPass`'s fact cell and wake this pass
 * through the dispatch graph. An initial-converge seed is primed from
 * `worklist.processTransform`.
 *
 * Side effects: the transfer mutates expression slots inside
 * `unit.body` and bumps `unit.structuralVersion` on fire; the worklist's
 * `processTransform` reacts to the version delta by setting
 * `anyChanged = true`, which marks the scope `"structural"` dirty and
 * rebuilds the CFG on the next drain iteration.
 */
export const constantFoldingRule: Pass<FunctionUnit, Fired> = {
  id: Symbol("constantFoldingRule"),
  debugName: "constantFoldingRule",
  lattice: firedLattice,
  reads: [constAnalysisPass, structuralPass],
  tier: "transform",
  // Precise affectedKeys: mirror `deadBranchRule`. A `structuralPass`
  // write for unit U enqueues this pass for U; `constAnalysisPass` is
  // node-keyed so we fall back to the explicit seed from
  // `processTransform` (no node-id → owning-unit map in ctx yet).
  affectedKeys(triggerPass, triggerKey) {
    if (triggerPass === (structuralPass as Pass<any, any>)) {
      return [triggerKey as FunctionUnit];
    }
    return [];
  },
  transfer(_ctx: PassCtx, key: FunctionUnit): Fired {
    const fired = applyConstantFoldingSweep(key);
    if (fired) {
      // Side-channel structural bump: the sweep mutated expression slots
      // in `key.body`, so CFG must be rebuilt. The worklist's
      // `processTransform` reads `unit.structuralVersion` before/after
      // `drainPasses()` and sets `anyChanged = true` on delta, triggering
      // the usual markDirty("structural") → rebuildStructural path.
      key.structuralVersion++;
      return "fired";
    }
    return undefined;
  },
};

/**
 * Memoization. Top-only `Pass<FunctionUnit, "fired">`. Side-effect
 * idempotence per plan resolution 3: the body-rewrite is one-shot; the
 * lattice's equality gate supersedes the legacy `appliedTransforms` set
 * (PR-6 deletes the set).
 */
export const memoizationRule: Pass<FunctionUnit, Fired> = {
  id: Symbol("memoizationRule"),
  debugName: "memoizationRule",
  lattice: firedLattice,
  reads: [callCountPass, purityScopePass],
  tier: "transform",
  coarse: true,
  transfer(_ctx: PassCtx, _key: FunctionUnit): Fired {
    return undefined;
  },
};

// Reserve the Scope-alias symbol so PR-5 can tighten `purityScopePass`
// and `callCountPass` to scope-keyed without changing the export surface.
export type Scope = StmtNS.FileInput | StmtNS.FunctionDef;
