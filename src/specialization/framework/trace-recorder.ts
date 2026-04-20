// In-memory collector for Worklist trace events.
//
//   const recorder = new TraceRecorder();
//   const wl = new Worklist(ast, envs, DEFAULT_PASSES, ..., recorder);
//   wl.drain();
//   console.log(formatTrace(recorder.events));          // terminal log
//   console.log(recorder.toJSON());                     // JSON for GPT dump
//   console.log(contextTimeline(recorder.events, ctx)); // enrichment history

import type { TraceEvent, TraceWrite, WorklistTracer } from "./tracer";

export class TraceRecorder implements WorklistTracer {
  private readonly _events: TraceEvent[] = [];

  onEvent(event: TraceEvent): void {
    this._events.push(event);
  }

  get events(): readonly TraceEvent[] {
    return this._events;
  }

  /** All events touching a specific pre-formatted context label. */
  forContext(contextLabel: string): TraceEvent[] {
    return this._events.filter(
      e => "context" in e && (e as { context: string }).context === contextLabel,
    );
  }

  /** All write events that advanced a cell, optionally filtered to one analysis. */
  advances(analysisName?: string): TraceWrite[] {
    return this._events.filter(
      (e): e is TraceWrite =>
        e.phase === "write" &&
        e.advanced &&
        (analysisName === undefined || e.analysis === analysisName),
    );
  }

  clear(): void {
    this._events.length = 0;
  }

  /** Raw JSON — paste into GPT for step-by-step walkthrough. */
  toJSON(): string {
    return JSON.stringify(this._events, null, 2);
  }
}
