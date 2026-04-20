// SVML JIT recompile-and-patch analysis.
//
// Evaluator-scoped, not framework. This file lives in `src/conductor/`
// because it is one concrete strategy for connecting the specialization
// engine to the SVML backend — compile a FunctionDef's IR, patch it into
// the interpreter's function table, memoize per (unit, speculation
// context). A different SVML evaluator could wire a different strategy
// (e.g. compile lazily on first dispatch, skip per-context caching,
// batch-compile at deopt). None of that belongs in the framework.
//
// WASM and CSE will each pick their own strategy (CSE: nothing — the
// AST-mutation transform loop already carries specialization to a
// tree-walker for free). The symbols this file imports from
// `../specialization/**` are therefore the empirical "flexible-enough
// integration surface" that any future evaluator-side recompile loop
// will lean on.
//
// ===== AUDIT: framework↔evaluator integration surface =====
//
// Types / values imported from `src/specialization/framework/**`:
//
//   analysis.ts
//     - `Analysis<K, V>`       — the registered citizen shape.
//     - `AnalysisCtx`          — handed to `transfer`. Carries `topology`
//                                (node/block/unit/fd lookups) and
//                                `currentAssumptionChain`.
//     - `EdgeSpec<K>`          — both fact and lifecycle edges.
//     - `Narrowing<K, V>`      — for enumerating the relevant speculation
//                                dimensions (cache partitioning).
//
//   cfg.ts
//     - `BasicBlock`           — snapshot map keys. A backend that does
//                                not snapshot per-block DFA facts would
//                                not need this.
//
//   context.ts
//     - `AssumptionChain`, `ROOT_CONTEXT` — the speculation-context axis. Any
//                                   backend that partitions artifacts by
//                                   speculation will consume these.
//
//   function-unit.ts
//     - `Unit`         — the key for jit-keyed cells.
//
//   analysis-store.ts
//     - `AnalysisStore<K, V>`  — per-Analysis storage. The jit Analysis's
//                                own `.store` carries its compiled-IR
//                                cell; snapshot reads tap other
//                                analyses' stores directly.
//
//   dfa-analyses.ts
//     - `JIT_RELEVANT_NARROWINGS` — default narrowing set for SVML; an
//                                   evaluator can override via `deps.narrowings`.
//
// Backend-supplied primitives (the other "end" of the interface):
//
//   - `compile(unit): IR`      — `SVMLCompiler.compileFunction`.
//   - `patch(index, ir): void` — `SVMLInterpreter.patchFunction` on a
//                                live function table.
//   - `indexOf(scope)`         — backend knows its own function index space.
//   - IR equality              — `structuralEquals` below; SVML-specific
//                                because `SVMLIR`'s shape is SVML-specific.
//   - Bottom IR sentinel       — `UNCOMPILED` below; a reference-unique
//                                `SVMLIR` distinct from every real compile.
//
// Gaps a WASM evaluator would expose (to be addressed in a separate
// design pass):
//
//   - WASM has no live function table today — `src/engines/wasm/index.ts`
//     builds one monolithic WAT and instantiates once. A JIT strategy
//     needs `WebAssembly.Table` of funcrefs + per-function mini-modules
//     whose exports can be set() into the table. That is an engine-side
//     redesign, not a framework change.
//   - Guard emission in WASM would need an equivalent of
//     `SVMLCompiler.guardRegistrar?.registerGuard(...)`; the worklist's
//     `GuardRegistrar` interface is already backend-agnostic.
//
// ===== end AUDIT =====
//
// Reads compile-relevant per-analysis-store signals (structural + DFA block
// facts) and, on lattice-change, recompiles the affected FunctionDef and
// patches its entry in the interpreter's function table. Side-effect
// idempotence: patchFunction only fires when the produced IR differs
// structurally from the previously-stored one; the IR itself is the
// stored cell value, so equal writes suppress onChange.
//
// Per-context artifact cache. The unit's active speculation context
// (`specAssumptionChainFor(unit)`) drives which IR the backend dispatches to. Each
// compile caches `(unit, context) → {snapshot, IR}`; subsequent transfers
// for a context we've compiled before reuse the cached IR and only patch.
// This is the deopt-without-recompile path: lineage-precise widen prunes
// the unit's context to an ancestor we already compiled under, and the
// next transfer hits the cache. Forward navigation (new observation → new
// child context) always misses and compiles.
//
// Historically callCount / purity were deliberately NOT tuple inputs: the
// shared-AST memoization transform read them indirectly and a call-count edge
// here would have forced pointless recompiles. With speculative cloned-body
// memoization, hotness can now shape the emitted IR for entry-specialized
// contexts, so `runtimeCallAnalysis` is allowed to wake the JIT. The transfer
// still suppresses patching on structurally-equal IR.

import { ExprNS, StmtNS } from "../ast-types";
import type { BasicBlock } from "../specialization/framework/cfg";
import { findAssumption, ROOT_CONTEXT, type AssumptionChain } from "../specialization/framework/context";
import type { Unit } from "../specialization/framework/function-unit";
import { defineAnalysis, type Analysis, type AnalysisCtx, type EdgeSpec, type Narrowing } from "../specialization/framework/analysis";
import { storeEvict } from "../specialization/framework/analysis-store";
import { JIT_RELEVANT_NARROWINGS } from "../specialization/framework/dfa-analyses";
import { paramKey } from "../specialization/framework/key-spaces";
import { runtimeCallAnalysis } from "../specialization/framework/runtime-analyses";
import type { SVMLCompiler } from "../engines/svml/svml-compiler";
import type { SVMLInterpreter } from "../engines/svml/svml-interpreter";
import { SVMLIR } from "../engines/svml/types";
import {
  contextIsEntrySpecializable,
  directParamEntryGuardsFor,
  guardKeyFromGuards,
  paramTypeNarrowing,
  type EntryGuard,
} from "../specialization/entry-guards";
import { specializedBodyFor, stmtsAreClonePure } from "../specialization/speculative-clone";
import {
  MEMOIZATION_THRESHOLD,
  memoWrappedBody,
} from "../specialization/transforms/memoization";

/** Snapshot of the inputs that determined a unit's compiled IR at some
 *  past compile under a specific context. Block-fact entries are
 *  reference-compared against `analysis.store.tryRead` on the next
 *  transfer: the store's eq-gated write preserves the previous reference
 *  when the new value is store-algebra-equal, so identity inequality is
 *  exactly "the DFA fact advanced".
 *
 *  Keyed by cell Analysis (each narrowing contributes its block DFA's
 *  paired `.env` and `.facts` cells) so the snapshot tracks both sides of
 *  the split block-fact domain. Adding a new narrowing extends the maps
 *  without touching this module. */
interface CompileSnapshot {
  structuralGen: number;
  memoHot: boolean;
  entryGuardKey: string | undefined;
  rootFacts: Map<Analysis<BasicBlock, unknown>, Map<BasicBlock, unknown>>;
  speculativeFacts: Map<Analysis<BasicBlock, unknown>, Map<BasicBlock, unknown>>;
}

interface CompiledArtifactDescriptor {
  readonly memoHot: boolean;
  readonly specBody: ReadonlyArray<StmtNS.Stmt> | undefined;
  readonly entryGuards: ReadonlyArray<EntryGuard> | undefined;
  readonly entryGuardKey: string | undefined;
}

/** Expand a narrowing into its cell analyses (both `.env` and `.facts`).
 *  JIT-relevant narrowings may read either side — return-kind's artifact
 *  shaping lives in the `.env` cell of typeRequirement; const narrowing's
 *  in the `.facts` cell of constAnalysis — so the snapshot captures both
 *  cells per narrowing and the edge list wakes on either's advance. */
function cellsOfNarrowing(n: Narrowing<any>): Array<Analysis<BasicBlock, unknown>> {
  const bfa = n.blockAnalysis();
  return [
    bfa.env as Analysis<BasicBlock, unknown>,
    bfa.facts as Analysis<BasicBlock, unknown>,
  ];
}

/** Per-context cache entry: the compiled IR and the snapshot of inputs it
 *  was compiled under. The cache key (outer `Map<AssumptionChain, ...>`) carries
 *  the context, so it's not repeated here. */
interface CacheEntry {
  readonly snapshot: CompileSnapshot;
  readonly ir: SVMLIR;
}

function isMemoizedClone(body: ReadonlyArray<StmtNS.Stmt> | undefined): boolean {
  const first = body?.[0];
  if (!(first instanceof StmtNS.If)) return false;
  const cond = first.condition;
  return cond instanceof ExprNS.Call
    && cond.callee instanceof ExprNS.Variable
    && cond.callee.name.lexeme === "__memo_has";
}

export interface JitPassDeps {
  readonly compiler: SVMLCompiler;
  readonly interpreter: SVMLInterpreter;
  /** Resolve the active speculation context for a unit. The compile-cache
   *  snapshots each narrowing's block facts under this context to detect
   *  when a new narrowing observation has landed and a recompile is due.
   *  Defaults to ROOT (no speculation visible) when omitted — appropriate
   *  only for fixtures that explicitly disable speculation. */
  readonly specAssumptionChainFor?: (unit: Unit) => AssumptionChain;
  /** Narrowings whose block-level facts drive recompile. Defaults to the
   *  subset the SVML backend actually consumes (`JIT_RELEVANT_NARROWINGS`).
   *  A backend that starts reading additional speculative facts should pass
   *  the widened list here so cache invalidation tracks them too. */
  readonly narrowings?: ReadonlyArray<Narrowing<any>>;
}

function blockToOwningUnit(_ctx: AnalysisCtx, key: unknown): Iterable<Unit> {
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

export function makeJitAnalysis(deps: JitPassDeps): Analysis<Unit, SVMLIR> {
  const { compiler, interpreter } = deps;
  const specAssumptionChainFor = deps.specAssumptionChainFor ?? ((_: Unit) => ROOT_CONTEXT);
  const narrowings = deps.narrowings ?? JIT_RELEVANT_NARROWINGS;

  /** Per-unit, per-context compiled-artifact cache. Outer key is the unit;
   *  inner key is the speculation context the IR was compiled under. Lookup
   *  on each transfer against the unit's current active context — a hit
   *  (same structuralGen, DFA facts unchanged) skips the compile entirely
   *  and just re-patches the cached IR. On unit rebuild (structural edit),
   *  the per-unit Map is cleared; stale contexts would never validate
   *  anyway, but dropping them also keeps the Map bounded. */
  const cache = new WeakMap<Unit, Map<AssumptionChain, CacheEntry>>();

  // Block-keyed DFA analysis: a fact-advancing change on a block invalidates
  // the memo of the owning unit. `transfer` decides whether the change
  // materially differs from the last compile via reference-identity compare
  // against the cache entry for the unit's active context.
  //
  // `contextPolicy: "root"` on every fact edge: jit cells are Unit-
  // keyed and the JIT analysis cell exists only at ROOT (holding the
  // currently-dispatched IR). A non-ROOT wake would enqueue jit at that
  // non-ROOT context, creating an orphan cell no one reads. The "root"
  // crossing lands the recompile request on the single ROOT JIT cell per
  // unit; the per-context cache lives outside the analysis store.
  //
  // Two edges per narrowing: one on `.env`, one on `.facts`. Each block DFA
  // is a paired-cell analysis since the DfaBlockFact split; either cell can
  // advance independently (e.g. an observation narrows an expr fact without
  // shifting the block's OUT env). The worklist's `pendingKeysByAnalysis`
  // dedup keeps a single JIT transfer per unit per drain, so the edge-count
  // doubling is idempotent at dispatch time.
  const edges: EdgeSpec<Unit>[] = narrowings.flatMap(n =>
    cellsOfNarrowing(n).map(cell => ({
      on: "fact" as const,
      analysis: cell,
      wake: blockToOwningUnit,
      contextPolicy: "root" as const,
    })),
  );
  edges.push(
    {
      on: "fact",
      analysis: runtimeCallAnalysis,
      wake: (ctx, functionId) => {
        const count = runtimeCallAnalysis.store.tryRead(functionId as number, ROOT_CONTEXT) ?? 0;
        if (count !== MEMOIZATION_THRESHOLD) return [];
        const u = ctx.topology.unitOfFunctionId(functionId as number);
        return u !== undefined && u.funcAst instanceof StmtNS.FunctionDef ? [u] : [];
      },
      contextPolicy: "root",
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
    // A pure spec-context shift (lineage-precise widen or whole-unit widen)
    // advances no DFA facts — the fact edges above would stay silent and
    // the JIT would never recompile into the guard-free IR. This edge is
    // what makes deopt declarative: backends throw `SpeculationViolation`
    // and call `worklist.widenGuard(nodeId)`; the worklist fires this
    // signal, which enqueues `jitAnalysis.transfer`, which re-reads
    // `specAssumptionChainFor(unit)` (now the pruned context) and patches the
    // function table.
    {
      on: "specContextChange",
      wake: (_ctx, unit) =>
        unit.funcAst instanceof StmtNS.FunctionDef ? [unit] : [],
    },
  );

  const jitStoreAlgebra = {
    bottom: UNCOMPILED,
    leq: structuralEquals,
    join: (_a: SVMLIR, b: SVMLIR) => b,
    eq: structuralEquals,
  };

  const jitAnalysis: Analysis<Unit, SVMLIR> = defineAnalysis({
    id: Symbol("jitAnalysis"),
    debugName: "jitAnalysis",
    storeAlgebra: jitStoreAlgebra,
    edges,
    tier: "analysis",
    polarity: "opaque",
    transfer(ctx: AnalysisCtx, unit: Unit): SVMLIR | undefined {
      const scope = unit.funcAst;
      if (!(scope instanceof StmtNS.FunctionDef)) return undefined;
      const index = compiler.indexOf(scope);
      if (index === undefined) return undefined;

      const specAssumptionChain = specAssumptionChainFor(unit);
      let perAssumptionChain = cache.get(unit);
      if (perAssumptionChain === undefined) {
        perAssumptionChain = new Map();
        cache.set(unit, perAssumptionChain);
      }

      const artifact = describeCompiledArtifact(unit, specAssumptionChain, ctx.topology);
      const cached = perAssumptionChain.get(specAssumptionChain);
      const reusable =
        cached !== undefined &&
        cached.snapshot.structuralGen === unit.generation &&
        snapshotMatches(unit, cached.snapshot, artifact, specAssumptionChain, narrowings, "reference")
          ? cached
          : findReusableEntry(unit, artifact, specAssumptionChain, perAssumptionChain, narrowings);
      if (reusable !== undefined) {
        // A sibling context may compile to the same artifact when the only
        // changed assumptions are in speculation dimensions the backend does
        // not consume directly (for example type-only write narrowings).
        // Memoize that reusable artifact under the current context too so the
        // next lookup hits directly.
        perAssumptionChain.set(specAssumptionChain, reusable);
        const currentIR = jitAnalysis.store.read(unit, ROOT_CONTEXT);
        if (structuralEquals(reusable.ir, currentIR)) return undefined;
        interpreter.patchFunction(index, reusable.ir);
        return reusable.ir;
      }

      const newCode = compiler.compileFunction(unit, artifact.specBody, artifact.entryGuards);
      perAssumptionChain.set(specAssumptionChain, {
        snapshot: captureSnapshot(unit, specAssumptionChain, narrowings, artifact),
        ir: newCode,
      });
      const prevIR = jitAnalysis.store.read(unit, ROOT_CONTEXT);
      if (structuralEquals(newCode, prevIR)) return undefined;
      interpreter.patchFunction(index, newCode);
      return newCode;
    },
  });
  // One lifecycle edge needs the jitAnalysis reference itself (for eviction);
  // appended after construction rather than inside `edges` to keep the fact-
  // edge list assembly straightforward.
  (jitAnalysis.edges as EdgeSpec<Unit>[]).push({
    on: "retire",
    effect: (_ctx, unit) => {
      storeEvict(jitAnalysis.store, unit, ROOT_CONTEXT);
      cache.delete(unit);
    },
  });
  // Rebuild invalidates every cached context's IR (CFG identities change,
  // and `structuralGen` mismatches anyway). Clear so the Map stays bounded.
  (jitAnalysis.edges as EdgeSpec<Unit>[]).push({
    on: "rebuild",
    effect: (_ctx, unit) => {
      cache.delete(unit);
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
 *  `specAssumptionChain` is both the cache lookup key and the context we read
 *  speculative facts under. Cache partitioning by context means `prev`
 *  was always captured under this `specAssumptionChain`. */
/** Widen param-const entry guards to param-type for memoized clones.
 *  Recursive calls with different (but same-typed) concrete values must pass
 *  the entry guard — GUARD_VAL(8) would reject x=4 from `hot(8)`→`hot(4)`,
 *  so we emit GUARD_KIND (type-level) instead. The type assumption is read
 *  from the same context that produced the const assumption. */
function widenForMemoization(
  unit: Unit,
  context: AssumptionChain,
): readonly EntryGuard[] | undefined {
  if (!(unit.funcAst instanceof StmtNS.FunctionDef)) return undefined;
  const guards: EntryGuard[] = [];
  for (let i = 0; i < unit.funcAst.parameters.length; i++) {
    const key = paramKey(unit.funcAst.id, i);
    const ty = findAssumption(context, paramTypeNarrowing, key);
    if (ty !== undefined) {
      guards.push({ kind: "param-type", paramIndex: i, ty });
    }
  }
  return guards.length > 0 ? guards : undefined;
}

/** Apply memoization to a pruned clone body if the function is hot and the
 *  body is pure. Uses type-widened guards as the memo partition key so that
 *  recursive calls with different same-typed arguments hit the same cache. */
function applyMemoPolicy(
  unit: Unit,
  context: AssumptionChain,
  fd: StmtNS.FunctionDef,
  body: ReadonlyArray<StmtNS.Stmt>,
  memoHot: boolean,
): ReadonlyArray<StmtNS.Stmt> {
  if (!memoHot) return body;
  if (isMemoizedClone(body)) return body;
  if (!stmtsAreClonePure(body, fd.name.lexeme)) return body;
  const widenedGuards = widenForMemoization(unit, context);
  return memoWrappedBody(fd, body, guardKeyFromGuards(widenedGuards));
}

function compiledEntryGuardsFor(
  unit: Unit,
  specAssumptionChain: AssumptionChain,
  specBody?: ReadonlyArray<StmtNS.Stmt>,
): ReadonlyArray<EntryGuard> | undefined {
  if (!contextIsEntrySpecializable(unit, specAssumptionChain)) return undefined;
  // Memoized clones need type-level guards so recursive calls with different
  // same-typed arguments pass the entry check (GUARD_KIND not GUARD_VAL).
  if (isMemoizedClone(specBody)) return widenForMemoization(unit, specAssumptionChain);
  return directParamEntryGuardsFor(unit, specAssumptionChain);
}

function describeCompiledArtifact(
  unit: Unit,
  specAssumptionChain: AssumptionChain,
  topology: AnalysisCtx["topology"],
): CompiledArtifactDescriptor {
  const fd = unit.funcAst;
  const memoHot = fd instanceof StmtNS.FunctionDef
    ? (runtimeCallAnalysis.store.tryRead(fd.id, ROOT_CONTEXT) ?? 0) >= MEMOIZATION_THRESHOLD
    : false;

  // Const-based pruning only when below the memoization threshold. Above
  // the threshold we switch to type-level guards (GUARD_KIND) and widen
  // the memo partition, so const-specific pruning is unsafe: it would
  // collapse termination conditions (e.g. x==1 in collatz) that are not
  // derivable from type alone, producing bodies that loop for other inputs
  // of the same type. Type-based pruning (e.g. INT_POS ≤ 0 = false) still
  // fires regardless of this flag.
  const pruned = specializedBodyFor(unit, specAssumptionChain, topology, !memoHot);
  const specBody = pruned !== undefined && fd instanceof StmtNS.FunctionDef
    ? applyMemoPolicy(unit, specAssumptionChain, fd, pruned, memoHot)
    : pruned;
  const entryGuards = compiledEntryGuardsFor(unit, specAssumptionChain, specBody);
  return {
    memoHot,
    specBody,
    entryGuards,
    entryGuardKey: guardKeyFromGuards(entryGuards),
  };
}

/** Compare current DFA facts against a prior compile snapshot.
 *
 *  `mode === "reference"` uses identity compare on fact cells — fast path
 *  for the exact-context cache hit, where the analysis store's eq-gated
 *  writes preserve reference when the value has not advanced.
 *  `mode === "semantic"` falls back to `storeAlgebra.eq` when references
 *  differ — used for cross-context reuse where two contexts can reach the
 *  same fixpoint via distinct cells. */
function snapshotMatches(
  unit: Unit,
  prev: CompileSnapshot,
  artifact: CompiledArtifactDescriptor,
  specAssumptionChain: AssumptionChain,
  narrowings: ReadonlyArray<Narrowing<any>>,
  mode: "reference" | "semantic",
): boolean {
  if (artifact.memoHot !== prev.memoHot) return false;
  if (artifact.entryGuardKey !== prev.entryGuardKey) return false;
  for (const n of narrowings) {
    for (const cell of cellsOfNarrowing(n)) {
      const rootMap = prev.rootFacts.get(cell);
      const specMap = prev.speculativeFacts.get(cell);
      if (rootMap === undefined || specMap === undefined) return false;
      for (const block of unit.blockMap.values()) {
        const rootNow = cell.store.tryRead(block, ROOT_CONTEXT);
        const rootPrev = rootMap.get(block);
        if (rootNow !== rootPrev) {
          if (mode === "reference") return false;
          if (rootNow === undefined || rootPrev === undefined) return false;
          if (!cell.storeAlgebra.eq(rootNow as never, rootPrev as never)) return false;
        }
        const specNow = mode === "semantic"
          ? (cell.store.tryRead(block, specAssumptionChain) ?? cell.store.tryRead(block, ROOT_CONTEXT))
          : cell.store.tryRead(block, specAssumptionChain);
        const specPrev = specMap.get(block);
        if (specNow !== specPrev) {
          if (mode === "reference") return false;
          if (specNow === undefined || specPrev === undefined) return false;
          if (!cell.storeAlgebra.eq(specNow as never, specPrev as never)) return false;
        }
      }
    }
  }
  return true;
}

/** Find an already-compiled artifact whose tracked inputs still match the
 *  unit's current relevant facts under `specAssumptionChain`, even if that artifact
 *  was originally cached under a different speculation context. Cross-context
 *  reuse compares semantically rather than by reference: identical fixpoints
 *  in two contexts are stored as distinct analysis-store cells, so the exact-hit
 *  identity check in `snapshotMatches` is too strong here. */
function findReusableEntry(
  unit: Unit,
  artifact: CompiledArtifactDescriptor,
  specAssumptionChain: AssumptionChain,
  perAssumptionChain: ReadonlyMap<AssumptionChain, CacheEntry>,
  narrowings: ReadonlyArray<Narrowing<any>>,
): CacheEntry | undefined {
  for (const [, entry] of perAssumptionChain) {
    if (entry.snapshot.structuralGen !== unit.generation) continue;
    if (entry.snapshot.memoHot !== artifact.memoHot) continue;
    if (entry.snapshot.entryGuardKey !== artifact.entryGuardKey) continue;
    if (snapshotMatches(unit, entry.snapshot, artifact, specAssumptionChain, narrowings, "semantic")) {
      return entry;
    }
  }
  return undefined;
}

function captureSnapshot(
  unit: Unit,
  specAssumptionChain: AssumptionChain,
  narrowings: ReadonlyArray<Narrowing<any>>,
  artifact: CompiledArtifactDescriptor,
): CompileSnapshot {
  const rootFacts = new Map<Analysis<BasicBlock, unknown>, Map<BasicBlock, unknown>>();
  const speculativeFacts = new Map<Analysis<BasicBlock, unknown>, Map<BasicBlock, unknown>>();
  for (const n of narrowings) {
    for (const cell of cellsOfNarrowing(n)) {
      const rootMap = new Map<BasicBlock, unknown>();
      const specMap = new Map<BasicBlock, unknown>();
      for (const block of unit.blockMap.values()) {
        rootMap.set(block, cell.store.tryRead(block, ROOT_CONTEXT));
        specMap.set(block, cell.store.tryRead(block, specAssumptionChain));
      }
      rootFacts.set(cell, rootMap);
      speculativeFacts.set(cell, specMap);
    }
  }
  return {
    structuralGen: unit.generation,
    memoHot: artifact.memoHot,
    entryGuardKey: artifact.entryGuardKey,
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
