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
import { ROOT_CONTEXT, type Context } from "../../specialization/framework/context";
import type { FunctionUnit } from "../../specialization/framework/function-unit";
import type { FactStore } from "../../specialization/framework/fact-store";
import type { Analysis, AnalysisCtx, EdgeSpec, NarrowingSpec } from "../../specialization/framework/analysis";
import { DEFAULT_NARROWINGS } from "../../specialization/framework/dfa-analyses";
import type { SVMLCompiler } from "./svml-compiler";
import type { SVMLInterpreter } from "./svml-interpreter";
import { SVMLIR } from "./types";

/** Snapshot of the inputs that determine a unit's compiled IR, captured at
 *  the last successful compile. Block-fact entries are reference-compared
 *  against `factStore.tryRead` on the next transfer: `FactStore.write` preserves
 *  the previous reference when the new value is lattice-equal, so identity
 *  inequality is exactly "the DFA fact advanced".
 *
 *  `rootFacts` and `speculativeFacts` are keyed by the narrowing whose
 *  block analysis produced them — one entry per registered narrowing.
 *  Adding a new narrowing extends the maps without touching this module. */
interface CompileSnapshot {
  structuralGen: number;
  /** Speculation context the speculative facts were read under. Compared
   *  by reference — a new observation produces a new Context object, so
   *  `prev.specContext !== now` short-circuits the full block-fact walk. */
  specContext: Context;
  rootFacts: Map<NarrowingSpec<any>, Map<BasicBlock, unknown>>;
  speculativeFacts: Map<NarrowingSpec<any>, Map<BasicBlock, unknown>>;
}

export interface JitPassDeps {
  readonly compiler: SVMLCompiler;
  readonly interpreter: SVMLInterpreter;
  /** Resolve the active speculation context for a unit. The compile-cache
   *  snapshots each narrowing's block facts under this context to detect
   *  when a new narrowing observation has landed and a recompile is due.
   *  Defaults to ROOT (no speculation visible) when omitted — appropriate
   *  only for fixtures that explicitly disable speculation. */
  readonly specContextFor?: (unit: FunctionUnit) => Context;
  /** Narrowings whose block-level facts drive recompile. Defaults to
   *  `DEFAULT_NARROWINGS`. A backend that registers additional narrowings
   *  passes the extended list here so its fact edges and snapshot maps
   *  widen accordingly. */
  readonly narrowings?: ReadonlyArray<NarrowingSpec<any>>;
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
  const specContextFor = deps.specContextFor ?? ((_: FunctionUnit) => ROOT_CONTEXT);
  const narrowings = deps.narrowings ?? DEFAULT_NARROWINGS;

  const blockAnalysisOf = (n: NarrowingSpec<any>): Analysis<any, any> => {
    const anchor = n.handle.specAnchor;
    if (anchor === undefined) {
      throw new Error(`[jit-analysis] narrowing "${n.handle.debugName}" has no specAnchor`);
    }
    return anchor.blockAnalysis();
  };

  const lastSnapshot = new WeakMap<FunctionUnit, CompileSnapshot>();

  // Block-keyed DFA analysis: a fact-advancing change on a block invalidates
  // the memo of the owning unit. `transfer` decides whether the change
  // materially differs from the last compile via reference-identity compare
  // against `lastSnapshot`.
  //
  // `contextPolicy: "root"` on every fact edge: jit cells are FunctionUnit-
  // keyed and exist only at ROOT — without the crossing, a non-ROOT write to
  // a narrowing's block analysis would enqueue jitAnalysis at that non-ROOT
  // context, creating an orphan cell no one reads. The "root" crossing
  // lands the recompile request on the single IR cell per unit.
  const edges: EdgeSpec<FunctionUnit>[] = narrowings.map(n => ({
    on: "fact",
    analysis: blockAnalysisOf(n),
    wake: blockToOwningUnit,
    contextPolicy: "root",
  }));
  edges.push(
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
    // A pure spec-context shift (lineage-precise widen or whole-unit widen)
    // advances no DFA facts — the fact edges above would stay silent and
    // the JIT would never recompile into the guard-free IR. This edge is
    // what makes deopt declarative: backends throw `SpeculationViolation`
    // and call `worklist.widenGuard(nodeId)`; the worklist fires this
    // signal, which enqueues `jitAnalysis.transfer`, which re-reads
    // `specContextFor(unit)` (now the pruned context) and patches the
    // function table.
    {
      on: "specContextChange",
      wake: (_ctx, unit) =>
        unit.funcAst instanceof StmtNS.FunctionDef ? [unit] : [],
    },
  );

  const jitAnalysis: Analysis<FunctionUnit, SVMLIR> = {
    id: Symbol("jitAnalysis"),
    debugName: "jitAnalysis",
    lattice: {
      bottom: UNCOMPILED,
      leq: structuralEquals,
      join: (_a, b) => b,
    },
    edges,
    tier: "analysis",
    transfer(factStore: FactStore, _ctx: AnalysisCtx, unit: FunctionUnit): SVMLIR | undefined {
      const scope = unit.funcAst;
      if (!(scope instanceof StmtNS.FunctionDef)) return undefined;
      const index = compiler.indexOf(scope);
      if (index === undefined) return undefined;

      const specContext = specContextFor(unit);
      const prev = lastSnapshot.get(unit);
      if (
        prev !== undefined &&
        prev.structuralGen === unit.generation &&
        snapshotMatches(factStore, unit, prev, specContext, narrowings, blockAnalysisOf)
      ) {
        return undefined;
      }

      const newCode = compiler.compileFunction(unit);
      lastSnapshot.set(unit, captureSnapshot(factStore, unit, specContext, narrowings, blockAnalysisOf));
      const prevIR = factStore.read(jitAnalysis, unit);
      if (structuralEquals(newCode, prevIR)) return undefined;
      interpreter.patchFunction(index, newCode);
      return newCode;
    },
  };
  // One lifecycle edge needs the jitAnalysis reference itself (for eviction);
  // appended after construction rather than inside `edges` to keep the fact-
  // edge list assembly straightforward.
  (jitAnalysis.edges as EdgeSpec<FunctionUnit>[]).push({
    on: "retire",
    effect: (factStore, _ctx, unit) => {
      factStore.evict(jitAnalysis, unit);
    },
  });
  return jitAnalysis;
}

/** Reference-identity compare of every block's per-narrowing DFA facts
 *  against the snapshot. A structural rebuild produces fresh `BasicBlock`
 *  instances, so the snapshot's Map keys become orphaned — but
 *  `prev.structuralGen === unit.generation` is already checked by the
 *  caller, so we only reach here when block identities match the snapshot.
 *
 *  `specContext` is the unit's active speculation context at snapshot time.
 *  If it's shifted between compiles (new observation → new context), the
 *  speculativeFacts map is keyed against the OLD context's cells; the
 *  caller uses the stored context for comparison via `prev.specContext`. */
function snapshotMatches(
  factStore: FactStore,
  unit: FunctionUnit,
  prev: CompileSnapshot,
  specContext: Context,
  narrowings: ReadonlyArray<NarrowingSpec<any>>,
  blockAnalysisOf: (n: NarrowingSpec<any>) => Analysis<any, any>,
): boolean {
  if (prev.specContext !== specContext) return false;
  for (const n of narrowings) {
    const blockAnalysis = blockAnalysisOf(n);
    const rootMap = prev.rootFacts.get(n);
    const specMap = prev.speculativeFacts.get(n);
    if (rootMap === undefined || specMap === undefined) return false;
    for (const block of unit.blockMap.values()) {
      if (factStore.tryRead(blockAnalysis, block) !== rootMap.get(block)) return false;
      if (factStore.tryRead(blockAnalysis, block, specContext) !== specMap.get(block)) return false;
    }
  }
  return true;
}

function captureSnapshot(
  factStore: FactStore,
  unit: FunctionUnit,
  specContext: Context,
  narrowings: ReadonlyArray<NarrowingSpec<any>>,
  blockAnalysisOf: (n: NarrowingSpec<any>) => Analysis<any, any>,
): CompileSnapshot {
  const rootFacts = new Map<NarrowingSpec<any>, Map<BasicBlock, unknown>>();
  const speculativeFacts = new Map<NarrowingSpec<any>, Map<BasicBlock, unknown>>();
  for (const n of narrowings) {
    const blockAnalysis = blockAnalysisOf(n);
    const rootMap = new Map<BasicBlock, unknown>();
    const specMap = new Map<BasicBlock, unknown>();
    for (const block of unit.blockMap.values()) {
      rootMap.set(block, factStore.tryRead(blockAnalysis, block));
      specMap.set(block, factStore.tryRead(blockAnalysis, block, specContext));
    }
    rootFacts.set(n, rootMap);
    speculativeFacts.set(n, specMap);
  }
  return {
    structuralGen: unit.generation,
    specContext,
    rootFacts,
    speculativeFacts,
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
