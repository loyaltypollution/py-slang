// src/specialization/framework/session.ts — resumable optimization session

import type { StmtNS } from "../../ast-types";
import { buildCFG } from "./cfg";
import type { HintStore } from "./hint";
import type { AnalysisModule, TransformRule } from "./interfaces";
import type { SlotLookup } from "./slot-table";
import { applyTransformPass } from "./transform";
import { drainAllAnalyses, makeSession } from "./worklist";

export type SessionState = "ready" | "analyzed";

export interface OptimizationSubscriber {
  readonly name: string;
  onRoundComplete?(session: OptimizationSession): void;
  onTransformsApplied?(session: OptimizationSession): void;
}

export class OptimizationSession {
  private _state: SessionState = "ready";
  private _round = 0;
  private readonly subscribers: OptimizationSubscriber[] = [];

  constructor(
    private readonly stmts: StmtNS.Stmt[],
    private readonly analyses: readonly AnalysisModule<any>[],
    private readonly transforms: readonly TransformRule[],
    readonly hints: HintStore,
    private readonly slotLookup: SlotLookup,
  ) {}

  get state(): SessionState { return this._state; }
  get round(): number { return this._round; }

  /** Run analysis: rebuild CFG, drain all analyses to fixpoint. */
  step(): void {
    const cfg = buildCFG(this.stmts);
    const sessions = this.analyses.map(m => makeSession(m, cfg));
    drainAllAnalyses(cfg, sessions, this.hints, this.slotLookup);
    this._round++;
    this._state = "analyzed";
    for (const sub of this.subscribers) sub.onRoundComplete?.(this);
  }

  /** Run transform rules. Returns true if any fired. No-op in "ready" state. */
  applyTransforms(): boolean {
    if (this._state !== "analyzed") return false;
    let changed = false;
    for (const rule of this.transforms) {
      changed = applyTransformPass(this.stmts, rule, this.hints) || changed;
    }
    this._state = "ready";
    for (const sub of this.subscribers) sub.onTransformsApplied?.(this);
    return changed;
  }

  /** Run to completion. Mirrors runCFGOptimization logic. */
  converge(maxRounds = 10): void {
    for (let i = 0; i < maxRounds; i++) {
      this.step();
      if (!this.applyTransforms()) return;
    }
    // Iteration cap: one final analysis pass to annotate surviving nodes.
    this.step();
  }

  addSubscriber(sub: OptimizationSubscriber): void {
    this.subscribers.push(sub);
  }

  removeSubscriber(sub: OptimizationSubscriber): void {
    const idx = this.subscribers.indexOf(sub);
    if (idx >= 0) this.subscribers.splice(idx, 1);
  }
}
