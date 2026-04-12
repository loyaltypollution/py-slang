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

  computeDelta(unit: FunctionUnit, _previous?: SVMLDelta): SVMLDelta {
    return { kind: "whole", ir: this.compiler.compileFunction(unit) };
  }

  applyDelta(scopeKey: StmtNS.FileInput | StmtNS.FunctionDef, delta: SVMLDelta): void {
    const index = this.compiler.indexOf(scopeKey);
    if (index === undefined) return;
    switch (delta.kind) {
      case "whole":
        this.interpreter.patchFunction(index, delta.ir);
        return;
      case "patches":
        this.interpreter.applyOperandPatches(index, delta.patches);
        return;
    }
  }
}
