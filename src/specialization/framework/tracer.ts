// Tracing interface and event types for the Worklist fixpoint computation.
//
// All TraceEvent fields are plain primitives (string, number, boolean) — no
// AssumptionChain, Analysis, or Unit objects. This lets trace consumers
// (formatters, JSON exporters, test assertions) work without any framework
// imports. Formatting helpers here convert framework objects to strings at
// emit-time inside the Worklist.
//
// Usage:
//   const recorder = new TraceRecorder();
//   const wl = new Worklist(ast, envs, ..., recorder);
//   wl.drain();
//   console.log(formatTrace(recorder.events));

import type { AssumptionChain } from "./context";
import { ROOT_CONTEXT } from "./context";

// ─── Event interfaces ────────────────────────────────────────────────────────

export interface TraceEnqueue {
  readonly phase: "enqueue";
  readonly seq: number;
  readonly analysis: string;
  readonly key: string;
  readonly context: string;
  readonly contextDepth: number;
  readonly reason: string;
}

export interface TraceDequeue {
  readonly phase: "dequeue";
  readonly seq: number;
  readonly analysis: string;
  readonly key: string;
  readonly context: string;
  readonly contextDepth: number;
}

export interface TraceTransfer {
  readonly phase: "transfer";
  readonly seq: number;
  readonly analysis: string;
  readonly key: string;
  readonly context: string;
  readonly contextDepth: number;
  readonly produced: boolean;
}

export interface TraceWrite {
  readonly phase: "write";
  readonly seq: number;
  readonly analysis: string;
  readonly key: string;
  readonly context: string;
  readonly contextDepth: number;
  readonly advanced: boolean;
  readonly oldValue: string;
  readonly newValue: string;
}

export interface TraceObserve {
  readonly phase: "observe";
  readonly seq: number;
  readonly analysis: string;
  readonly key: string;
  readonly rawKind: string;
}

export interface TraceStrategy {
  readonly phase: "strategy";
  readonly seq: number;
  readonly unit: string;
  readonly key: string;
  readonly rawKind: string;
  readonly accepted: boolean;
  readonly parentContextDepth: number;
}

export interface TraceContextExtend {
  readonly phase: "context-extend";
  readonly seq: number;
  readonly unit: string;
  readonly handle: string;
  readonly key: string;
  readonly value: string;
  readonly parentDepth: number;
  readonly resultDepth: number;
  readonly resultContext: string;
}

export interface TraceContextExclude {
  readonly phase: "context-exclude";
  readonly seq: number;
  readonly unit: string;
  readonly handle: string;
  readonly key: string;
  readonly parentDepth: number;
  readonly resultDepth: number;
  readonly resultContext: string;
}

export interface TraceSpecContextChange {
  readonly phase: "spec-context-change";
  readonly seq: number;
  readonly unit: string;
  readonly kind: "extend" | "prune" | "prune-full";
  readonly newContextLabel: string;
  readonly newContextDepth: number;
}

export interface TraceDrainIteration {
  readonly phase: "drain-iteration";
  readonly seq: number;
  readonly iteration: number;
  readonly transformsFired: boolean;
  readonly rebuiltUnits: string[];
}

export interface TraceTransformSweep {
  readonly phase: "transform-sweep";
  readonly seq: number;
  readonly rule: string;
  readonly unit: string;
  readonly fired: boolean;
}

export interface TraceWidenGuard {
  readonly phase: "widen-guard";
  readonly seq: number;
  readonly guardNodeId: number;
  readonly unit: string;
  readonly loadBearingAssumptions: string[];
  readonly widenedToRoot: boolean;
}

export type TraceEvent =
  | TraceEnqueue
  | TraceDequeue
  | TraceTransfer
  | TraceWrite
  | TraceObserve
  | TraceStrategy
  | TraceContextExtend
  | TraceContextExclude
  | TraceSpecContextChange
  | TraceDrainIteration
  | TraceTransformSweep
  | TraceWidenGuard;

// ─── WorklistTracer interface ─────────────────────────────────────────────────

export interface WorklistTracer {
  onEvent(event: TraceEvent): void;
}

// ─── Formatting helpers (used by Worklist at emit-time) ──────────────────────

export function formatKey(key: unknown): string {
  if (key === null || key === undefined) return String(key);
  if (typeof key === "number" || typeof key === "string") return String(key);
  if (typeof key === "object") {
    if ("id" in (key as object)) return `block#${(key as { id: unknown }).id}`;
    if ("kind" in (key as object)) return String((key as { kind: unknown }).kind);
  }
  return "[obj]";
}

export function formatValue(value: unknown): string {
  if (value === undefined || value === null) return "⊥";
  try {
    const s = JSON.stringify(value);
    return s.length > 80 ? s.slice(0, 77) + "…" : s;
  } catch {
    return String(value);
  }
}

export function describeContext(ctx: AssumptionChain): string {
  if (ctx === ROOT_CONTEXT || ctx.depth === 0) return "ROOT";
  const parts: string[] = [];
  for (let c: AssumptionChain | undefined = ctx; c !== undefined; c = c.parent) {
    if (c.assumption === undefined) continue;
    const { narrowing, key, value } = c.assumption;
    parts.push(`${narrowing.debugName}:${formatKey(key)}=${formatValue(value)}`);
  }
  return "[" + parts.join(", ") + "]";
}
