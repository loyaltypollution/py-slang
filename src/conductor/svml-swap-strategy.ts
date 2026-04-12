// src/conductor/svml-swap-strategy.ts — SVML state-delta strategy.
//
// Bridges the specialization engine's StateDeltaStrategy<Delta> into the SVML
// backend. Supports two delta shapes:
//
//   - `{ kind: 'whole', ir }`  — whole-function recompile + patchFunction.
//   - `{ kind: 'patches', patches }` — operand-level mutation in place.
//
// The coordinator calls `computeDelta(unit)` and then `applyDelta(key, delta)`;
// the pin-set contract (PersistentWorklist.activateScope) guarantees neither
// path runs while a frame of the target scope is on the stack.
//
// Current production behavior: emits `{ kind: 'whole', ir }` for every change,
// preserving pre-rename semantics exactly. Operand-patch emission is unlocked
// at the framework level (SVMLInterpreter.applyOperandPatches) so transform
// code can emit targeted patches as they come online, without further
// infrastructure churn.

import { StmtNS } from "../ast-types";
import type { FunctionUnit } from "../specialization";
import type { StateDeltaStrategy } from "../specialization";
import type { SVMLCompiler } from "../engines/svml/svml-compiler";
import type { SVMLInterpreter } from "../engines/svml/svml-interpreter";
import type { OperandPatch, SVMLIR } from "../engines/svml/types";

export type SVMLDelta =
  | { readonly kind: "whole"; readonly ir: SVMLIR }
  | { readonly kind: "patches"; readonly patches: readonly OperandPatch[] };

export class SVMLSwapStrategy implements StateDeltaStrategy<SVMLDelta> {
  constructor(
    private readonly compiler: SVMLCompiler,
    private readonly interpreter: SVMLInterpreter,
  ) {}

  /**
   * FileInput is the program entry; it cannot be per-function patched
   * (compileProgram handles the whole program). Per-function recompile only
   * applies to FunctionDef bodies.
   */
  canInstall(scopeKey: StmtNS.FileInput | StmtNS.FunctionDef): boolean {
    return scopeKey instanceof StmtNS.FunctionDef;
  }

  /**
   * Safe for the current delta shape (`{ kind: "whole" }`): `patchFunction`
   * swaps the IR slot, and `CallFrame` holds a direct IR reference captured
   * at call time, so live frames execute the old IR to completion while new
   * dispatches land on the new IR. Only FunctionDef scopes — FileInput is
   * rebuilt whole-program.
   *
   * Operand-level patches (`{ kind: "patches" }`) mutate the typed arrays
   * live frames are reading from, so they are NOT safe on-stack. If/when
   * `computeDelta` starts emitting patches, this guard must branch on delta
   * shape — today it always emits whole, so a simple scope-level answer is
   * sufficient.
   */
  canInstallOnStack(scopeKey: StmtNS.FileInput | StmtNS.FunctionDef): boolean {
    return scopeKey instanceof StmtNS.FunctionDef;
  }

  computeDelta(unit: FunctionUnit): SVMLDelta {
    return { kind: "whole", ir: this.compiler.compileFunction(unit) };
  }

  applyDelta(scopeKey: StmtNS.FileInput | StmtNS.FunctionDef, delta: SVMLDelta): void {
    const index = this.compiler.indexOf(scopeKey);
    if (index === undefined) return;
    switch (delta.kind) {
      case "whole":
        // canInstallOnStack guarantees this is safe even when `scopeKey` is
        // on the live call stack; pass the opt-in so `patchFunction` skips
        // its strict pin-set assertion.
        this.interpreter.patchFunction(index, delta.ir, /* allowOnStack */ true);
        return;
      case "patches":
        // Typed-array mutation is NOT on-stack safe; strategy never emits
        // this for pinned scopes (canInstallOnStack semantics — once this
        // branch is exercised it must gate on delta kind).
        this.interpreter.applyOperandPatches(index, delta.patches);
        return;
    }
  }
}
