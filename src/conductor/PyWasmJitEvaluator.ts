// PyWasmJitEvaluator — design stub.
//
// NOT YET IMPLEMENTED. `evaluateChunk` throws. This file exists as the
// design-locked skeleton for wiring specialization to a WASM backend.
// The comment block below is the contract we intend to hit; the code is
// placeholder until the engine-side refactors it depends on land.
//
// ---------------------------------------------------------------------
// WHY A STUB AND NOT JUST A MISSING FILE
//
// `conductor/svml-jit-analysis.ts` documented the specialization↔evaluator
// integration surface empirically (what an SVML recompile loop imports
// from `../specialization/**`). A WASM evaluator would lean on the same
// surface, but WASM's runtime model is incompatible with the SVML
// strategy out-of-the-box. This stub captures the gap and fixes the
// design direction before any code is written.
//
// ---------------------------------------------------------------------
// CURRENT WASM ARCHITECTURE (blocker)
//
// `src/engines/wasm/index.ts` and `builderGenerator.ts` produce ONE
// monolithic WAT module. User functions are not standalone wasm
// functions — each user function body is an arm of a `br_table`
// inside a single `$_apply` function (see `applyFuncFactory` in
// `constants.ts:975`, br_table at `:1167-1176`). Dispatch is by closure
// tag: `br_table ($tag) [ body_0, body_1, ..., body_N ]`.
//
// WebAssembly function bodies are IMMUTABLE after instantiation. There
// is no `patchFunction(index, newCode)` analogue. The SVML strategy
// ("recompile one FunctionDef, set it in the interpreter's function
// table") has no native counterpart here.
//
// ---------------------------------------------------------------------
// PROPOSED DISPATCH MODEL (Option D — live funcref table with br_table fallback)
//
// Engine-side refactors required (in `src/engines/wasm/`):
//
//   1. Each user function compiles to its own standalone wasm function,
//      exported from a per-function "mini-module". Signature mirrors the
//      body's current call shape:
//          (param $ret_env i32) (param $val i64) (param $arg_len i32)
//          (result i32 i64)
//      CURR_ENV, MALLOC_FX, PRE_APPLY_FX, MAKE_NONE_FX, and the memory
//      object are imported from the main module (all already addressable
//      as wasm module imports).
//
//   2. Main module declares a `(table $user_fns funcref)` of size
//      numUserFunctions, exported writable to JS. Initial contents: null
//      refs (slot 0 reserved for "unspecialized fallback"; see 3).
//
//   3. `$_apply` replaces the `br_table` with a single
//      `call_indirect (type $user_fn_sig) (table $user_fns) (local.get $tag)`.
//      The fallback br_table body stays compiled into a second table
//      `$user_fns_fallback`, same indexing. When `$user_fns[tag]` is null,
//      `$_apply` dispatches through the fallback table. JIT writes
//      specialized variants into `$user_fns[tag]`; deopt clears the slot
//      (setting it to null), letting subsequent calls fall back.
//
//   4. Closures encode tag; nothing changes at the closure construction
//      site (`visitFunctionDefStmt`, `MAKE_CLOSURE_FX`). The tag still
//      selects among bodies — just via table lookup now.
//
// Evaluator-side recompile loop (this file, future implementation):
//
//   - Compile one Unit → mini-module (WAT → wasm bytes → instantiate
//     with imports bound to the main instance's exports).
//   - Extract `instance.exports.fn` (a JS-exposed funcref after
//     `WebAssembly.Function` or equivalent — see `--enable-function-references`
//     proposal; current stable: extract via a separate table).
//   - `mainInstance.exports.user_fns.set(tag, newFuncRef)`.
//   - Memoize per (unit, speculation context) like the SVML path does;
//     the per-context cache shape transfers 1:1.
//
// ---------------------------------------------------------------------
// DEOPT MODEL (harder than SVML)
//
// SVML's deopt: guard throws `SpeculationViolation`, the interpreter
// loop in JS catches it mid-instruction-stream, calls `worklist.widenGuard`,
// re-dispatches the next instruction under the widened context. Execution
// never leaves the interpreter.
//
// WASM's deopt: a throw from inside wasm unwinds the entire wasm call
// stack. There is no on-stack replacement. Two viable responses:
//
//   (a) Guard-at-call-boundary only. A mid-function guard cannot
//       meaningfully retry — it has already consumed stack, environment,
//       observations. Instead, guards emit at FUNCTION ENTRY: at call
//       time, check that the observed arg kinds match the speculated
//       ones; if not, return an error sentinel. The caller's dispatch
//       (inside `$_apply`) checks the sentinel, re-reads the function
//       table (JIT may have patched it during the failing call's
//       registration), and retries `call_indirect`. This narrows the
//       speculation class WASM can exploit vs. SVML (no inline-point
//       narrowings), but is what the runtime model actually supports.
//
//   (b) Whole-program re-entry. On any guard throw, catch in JS, call
//       `worklist.widenGuard`, recompile, re-run `exports.main()` from
//       scratch. Only viable if I/O is idempotent or buffered until
//       program completion. Not our situation — `evaluateChunk` streams
//       output via `sendOutput`. Reject.
//
// Pick (a). The evaluator's job for deopt: catch the sentinel surfacing
// out of `main()` (if the outer `$_apply` chose to propagate rather than
// retry), or — more likely — never see it, because the in-wasm retry
// loop handles it invisibly. `registerGuard` is still called at emission
// time; the mechanism matches SVML's shape, only the triggering signal
// changes from "JS throw" to "sentinel return + table repatch".
//
// ---------------------------------------------------------------------
// WHAT'S ALREADY FLEXIBLE ENOUGH (checked against the SVML audit)
//
//   - `Analysis<K, V>` / `EdgeSpec` / `Narrowing`: no SVML assumptions.
//   - `GuardRegistrar` (worklist.ts:64): the WASM compiler just calls
//     `registerGuard(nodeId, { narrowing, key })` the same way
//     `SVMLCompiler` does at `svml-compiler.ts:367`. No framework change.
//   - `FactStore` read/write/evict: backend-agnostic.
//   - `specContextFor(unit)` / `Context` / `ROOT_CONTEXT`: backend-
//     agnostic speculation-context axis.
//
// WHAT'S SVML-SPECIFIC (will be mirrored locally here, not lifted to a
// framework helper):
//
//   - The `SVMLIR` IR type → WASM equivalent will be a mini-module
//     artifact (wasm bytes + extracted funcref handle + per-guard
//     nodeId map). Defined adjacent to this file when implementation
//     begins.
//   - `structuralEquals` over SVMLIR → WASM equivalent will compare the
//     wasm bytes + the guard-nodeId map. Equal bytes ⇒ skip the
//     `table.set` (avoids churning the funcref for a no-op recompile).
//   - `UNCOMPILED` sentinel → a null funcref (or a reserved "not yet"
//     index into a pre-initialized fallback table).
//
// ---------------------------------------------------------------------
// IMPLEMENTATION SEQUENCE (when we pick this up)
//
//   1. Engine-side: refactor `BuilderGenerator` to emit user functions as
//      standalone wasm functions + `(table $user_fns_fallback funcref)`.
//      This is a pure refactor — same semantics, same output for a
//      program with no JIT. Validates the dispatch redesign in isolation.
//
//   2. Engine-side: add an empty `(table $user_fns funcref (ref.null ...))`
//      and the call_indirect-with-fallback trampoline in `$_apply`.
//      Still no JIT; confirms the live-patch primitive exists and is
//      addressable.
//
//   3. Evaluator-side: this file grows a `makeWasmJitAnalysis` mirroring
//      the SVML one. Backend-specific primitives: mini-module compile,
//      funcref extraction, `table.set` patch, bytes-equals IR eq.
//
//   4. Guard emission + boundary-retry loop. Only now does observation →
//      context extension → recompile → deopt actually run end-to-end.
//
// Steps 1-2 are pure engine refactors and can proceed independently of
// the specialization wiring. Step 3 depends on them. Step 4 is the
// semantic payoff and depends on all prior.

import { BasicEvaluator, IRunnerPlugin } from "@sourceacademy/conductor/runner";

export class PyWasmJitEvaluator extends BasicEvaluator {
  constructor(conductor: IRunnerPlugin) {
    super(conductor);
  }

  async evaluateChunk(_chunk: string): Promise<void> {
    throw new Error(
      "PyWasmJitEvaluator is not yet implemented. See the design note at the top of this file for the dispatch-indirection redesign this evaluator depends on.",
    );
  }
}
