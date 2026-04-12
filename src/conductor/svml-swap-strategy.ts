// src/conductor/svml-swap-strategy.ts — SVML-backed OSR swap strategy.
//
// Bridges the specialization engine's CodeSwapStrategy<Code> into the SVML
// backend: `recompile` delegates to SVMLCompiler.compileFunction (which
// preserves stable function indices across recompiles), `install` patches
// the running interpreter's program via SVMLInterpreter.patchFunction.
//
// The OSR safepoint contract (PersistentWorklist's activateScope pinning)
// guarantees `install` is never invoked for a scope whose frame is live, so
// the patch is safe; patchFunction still checks defensively.

import { StmtNS } from "../ast-types";
import type { FunctionUnit } from "../specialization";
import type { CodeSwapStrategy } from "../specialization";
import type { SVMLCompiler } from "../engines/svml/svml-compiler";
import type { SVMLInterpreter } from "../engines/svml/svml-interpreter";
import type { SVMLIR } from "../engines/svml/types";

export class SVMLSwapStrategy implements CodeSwapStrategy<SVMLIR> {
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

  recompile(unit: FunctionUnit): SVMLIR {
    return this.compiler.compileFunction(unit);
  }

  install(scopeKey: StmtNS.FileInput | StmtNS.FunctionDef, code: SVMLIR): void {
    const index = this.compiler.indexOf(scopeKey);
    if (index === undefined) return;
    this.interpreter.patchFunction(index, code);
  }
}
