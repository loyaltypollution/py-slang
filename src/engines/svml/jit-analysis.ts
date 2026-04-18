// JIT recompile-and-patch analysis. Reads compile-relevant fact-store signals
// (structural + DFA block facts) and, on lattice-change, recompiles the
// affected FunctionDef and patches its entry in the interpreter's function
// table. Side-effect idempotence: patchFunction only fires when the
// produced IR differs structurally from the previously-stored one; the
// IR itself is the lattice value, so equal writes suppress onChange.
//
// callCount / purity are deliberately NOT tuple inputs: compileFunction does
// not read them. Their effect on the emitted IR is indirect — memoizationRule
// reads them and, on fire, wraps the body. That wrap is a structural edit
// which propagates to jitAnalysis via the worklist's `onUnitRebuilt` hook.
// Including them directly would force a recompile on every observed call (up
// to RUNTIME_CALL_COUNT_SAT) for a function whose IR does not change, which
// dominated runtime on tight hot loops.

import { StmtNS } from "../../ast-types";
import type { BasicBlock } from "../../specialization/framework/cfg";
import type { FunctionUnit } from "../../specialization/framework/function-unit";
import type { FactStore } from "../../specialization/framework/fact-store";
import type { Analysis, AnalysisCtx } from "../../specialization/framework/analysis";
import {
  constAnalysis,
  speculativeConstAnalysis,
  speculativeTypeAnalysis,
  typeAnalysis,
} from "../../specialization/framework/dfa-analyses";
import { speculationBlacklistAnalysis } from "../../specialization/framework/runtime-analyses";
import type { SVMLCompiler } from "./svml-compiler";
import type { SVMLInterpreter } from "./svml-interpreter";
import { SVMLIR } from "./types";

/** Snapshot of the inputs that determine a unit's compiled IR, captured at
 *  the last successful compile. Block-fact entries are reference-compared
 *  against `factStore.tryRead` on the next transfer: `FactStore.write` preserves
 *  the previous reference when the new value is lattice-equal, so identity
 *  inequality is exactly "the DFA fact advanced". */
interface CompileSnapshot {
  structuralGen: number;
  constFacts: Map<BasicBlock, unknown>;
  typeFacts: Map<BasicBlock, unknown>;
  /** Speculative facts also flow into the compiled IR (via GUARD_KIND
   *  emissions). Including their references here is what makes
   *  recompile-on-deopt fire. */
  speculativeTypeFacts: Map<BasicBlock, unknown>;
  speculativeConstFacts: Map<BasicBlock, unknown>;
  /** Per-nodeId blacklist snapshot. Deopt sets a node to true; on next
   *  compile, the compiler reads the blacklist and falls back to generic. */
  blacklistedNodes: Set<number>;
}

export interface JitPassDeps {
  readonly compiler: SVMLCompiler;
  readonly interpreter: SVMLInterpreter;
}

function blockToOwningUnit(_ctx: AnalysisCtx, key: unknown): Iterable<FunctionUnit> {
  const block = key as BasicBlock;
  const unit = block.unit;
  if (unit === undefined) return [];
  return unit.funcAst instanceof StmtNS.FunctionDef ? [unit] : [];
}

/** Sentinel "not yet compiled" — a unique SVMLIR instance distinct from every real one by reference. */
const UNCOMPILED: SVMLIR = new SVMLIR(
  new Int32Array(0),
  new Float64Array(0),
  new Int32Array(0),
  [],
  0,
  0,
  0,
);

export function makeJitAnalysis(deps: JitPassDeps): Analysis<FunctionUnit, SVMLIR> {
  const { compiler, interpreter } = deps;

  const lastSnapshot = new WeakMap<FunctionUnit, CompileSnapshot>();

  const jitAnalysis: Analysis<FunctionUnit, SVMLIR> = {
    id: Symbol("jitAnalysis"),
    debugName: "jitAnalysis",
    lattice: {
      bottom: UNCOMPILED,
      leq: structuralEquals,
      join: (_a, b) => b,
    },
    edges: [
      // Block-keyed DFA analysis: a fact-advancing change on a block invalidates
      // the memo of the owning unit. `transfer` decides whether the change
      // materially differs from the last compile via reference-identity
      // compare against `lastSnapshot`.
      { on: "fact", analysis: typeAnalysis, wake: blockToOwningUnit },
      { on: "fact", analysis: constAnalysis, wake: blockToOwningUnit },
      { on: "fact", analysis: speculativeTypeAnalysis, wake: blockToOwningUnit },
      { on: "fact", analysis: speculativeConstAnalysis, wake: blockToOwningUnit },
      // Blacklist update at nodeId N → recompile the unit owning N.
      {
        on: "fact",
        analysis: speculationBlacklistAnalysis,
        wake: (ctx, key) => {
          const unit = ctx.unitForNode(key as number);
          if (unit === undefined) return [];
          return unit.funcAst instanceof StmtNS.FunctionDef ? [unit] : [];
        },
      },
      {
        on: "mint",
        wake: (_ctx, unit) =>
          unit.funcAst instanceof StmtNS.FunctionDef ? [unit] : [],
      },
      {
        on: "rebuild",
        wake: (_ctx, unit) =>
          unit.funcAst instanceof StmtNS.FunctionDef ? [unit] : [],
      },
      {
        on: "retire",
        effect: (factStore, _ctx, unit) => {
          factStore.evict(jitAnalysis, unit);
        },
      },
    ],
    tier: "analysis",
    transfer(factStore: FactStore, _ctx: AnalysisCtx, unit: FunctionUnit): SVMLIR | undefined {
      const scope = unit.funcAst;
      if (!(scope instanceof StmtNS.FunctionDef)) return undefined;
      const index = compiler.indexOf(scope);
      if (index === undefined) return undefined;

      const prev = lastSnapshot.get(unit);
      if (
        prev !== undefined &&
        prev.structuralGen === unit.generation &&
        snapshotMatches(factStore, unit, prev)
      ) {
        return undefined;
      }

      const newCode = compiler.compileFunction(unit);
      lastSnapshot.set(unit, captureSnapshot(factStore, unit));
      const prevIR = factStore.read(jitAnalysis, unit);
      if (structuralEquals(newCode, prevIR)) return undefined;
      interpreter.patchFunction(index, newCode);
      return newCode;
    },
  };
  return jitAnalysis;
}

/** Reference-identity compare of every block's DFA facts against the snapshot.
 *  A structural rebuild produces fresh `BasicBlock` instances, so the snapshot's
 *  Map keys become orphaned — but `prev.structuralGen === unit.generation` is
 *  already checked by the caller, so we only reach here when block identities
 *  match the snapshot. */
function snapshotMatches(
  factStore: FactStore,
  unit: FunctionUnit,
  prev: CompileSnapshot,
): boolean {
  for (const block of unit.blockMap.values()) {
    if (factStore.tryRead(constAnalysis, block) !== prev.constFacts.get(block)) return false;
    if (factStore.tryRead(typeAnalysis, block) !== prev.typeFacts.get(block)) return false;
    if (factStore.tryRead(speculativeTypeAnalysis, block) !== prev.speculativeTypeFacts.get(block)) return false;
    if (factStore.tryRead(speculativeConstAnalysis, block) !== prev.speculativeConstFacts.get(block)) return false;
  }
  // Blacklist: any nodeId in the unit that's now blacklisted but wasn't at
  // the snapshot, or vice versa, invalidates the cache.
  for (const nodeId of unit.blockOfNode.keys()) {
    const now = factStore.tryRead(speculationBlacklistAnalysis, nodeId) === true;
    const then = prev.blacklistedNodes.has(nodeId);
    if (now !== then) return false;
  }
  return true;
}

function captureSnapshot(factStore: FactStore, unit: FunctionUnit): CompileSnapshot {
  const constFacts = new Map<BasicBlock, unknown>();
  const typeFacts = new Map<BasicBlock, unknown>();
  const speculativeTypeFacts = new Map<BasicBlock, unknown>();
  const speculativeConstFacts = new Map<BasicBlock, unknown>();
  const blacklistedNodes = new Set<number>();
  for (const block of unit.blockMap.values()) {
    constFacts.set(block, factStore.tryRead(constAnalysis, block));
    typeFacts.set(block, factStore.tryRead(typeAnalysis, block));
    speculativeTypeFacts.set(block, factStore.tryRead(speculativeTypeAnalysis, block));
    speculativeConstFacts.set(block, factStore.tryRead(speculativeConstAnalysis, block));
  }
  for (const nodeId of unit.blockOfNode.keys()) {
    if (factStore.tryRead(speculationBlacklistAnalysis, nodeId) === true) {
      blacklistedNodes.add(nodeId);
    }
  }
  return {
    structuralGen: unit.generation,
    constFacts,
    typeFacts,
    speculativeTypeFacts,
    speculativeConstFacts,
    blacklistedNodes,
  };
}

/**
 * Collision-free structural equality over two SVMLIR instances. Fails fast
 * on first divergence. A hash would risk suppressing a required patchFunction.
 */
function i32Equals(a: Int32Array, b: Int32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Float64: bitwise NaN-safe compare — two NaNs compare equal if bit-identical.
function f64Equals(a: Float64Array, b: Float64Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x !== y && !(Number.isNaN(x) && Number.isNaN(y))) return false;
  }
  return true;
}

function strEquals(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function structuralEquals(a: SVMLIR, b: SVMLIR): boolean {
  if (a === b) return true;
  return (
    a.count === b.count &&
    a.stackSize === b.stackSize &&
    a.envSize === b.envSize &&
    a.numArgs === b.numArgs &&
    i32Equals(a.opcodes, b.opcodes) &&
    i32Equals(a.arg2s, b.arg2s) &&
    f64Equals(a.arg1s, b.arg1s) &&
    strEquals(a.strings, b.strings)
  );
}
