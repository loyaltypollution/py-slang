// Formatters for WorklistTracer event streams.
//
// formatTrace(events)           — terminal-style execution log
// contextTimeline(events, ctx)  — per-context enrichment history
// toMermaid(worklist, opts)     — flowchart TD with per-block lattice values

import type { TraceEvent } from "./tracer";
import type { Analysis } from "./analysis";
import type { AssumptionChain } from "./context";
import { ROOT_CONTEXT } from "./context";
import { describeContext, formatKey, formatValue } from "./tracer";

// ─── Terminal log ─────────────────────────────────────────────────────────────

export interface FormatTraceOptions {
  /** Include write no-ops (default: false — too noisy). */
  showNoops?: boolean;
  /** Include transfer events that produced no value (default: false). */
  showNullTransfers?: boolean;
  /** Filter to only events touching this context label. */
  filterContext?: string;
  /** Filter to only events for these analysis names. */
  filterAnalyses?: string[];
}

/** Produce a human-readable terminal log of the fixpoint computation.
 *
 *  Output columns:
 *    seq    — global event sequence number
 *    phase  — event kind (enqueue, pop, transfer, write, …)
 *    target — analysis(key, ctx)
 *    detail — reason for enqueue / advance info / strategy decision
 */
export function formatTrace(
  events: readonly TraceEvent[],
  opts: FormatTraceOptions = {},
): string {
  const lines: string[] = [];
  let drainIteration = -1;

  for (const e of events) {
    if (opts.filterContext !== undefined) {
      if ("context" in e && (e as { context: string }).context !== opts.filterContext) continue;
    }
    if (opts.filterAnalyses !== undefined && opts.filterAnalyses.length > 0) {
      if ("analysis" in e && !opts.filterAnalyses.includes((e as { analysis: string }).analysis)) continue;
    }

    switch (e.phase) {
      case "drain-iteration": {
        drainIteration = e.iteration;
        lines.push("");
        lines.push(`${"─".repeat(72)}`);
        lines.push(
          `DRAIN ITERATION ${e.iteration}` +
          (e.transformsFired ? `  transforms fired` : "") +
          (e.rebuiltUnits.length > 0 ? `  rebuilt: ${e.rebuiltUnits.join(", ")}` : ""),
        );
        lines.push(`${"─".repeat(72)}`);
        break;
      }

      case "enqueue": {
        lines.push(
          pad(e.seq, 5) +
          "  enqueue  " +
          padR(`${e.analysis}(${e.key}, ${e.context})`, 48) +
          e.reason,
        );
        break;
      }

      case "dequeue": {
        lines.push(
          pad(e.seq, 5) +
          "  pop      " +
          `${e.analysis}(${e.key}, ${e.context})`,
        );
        break;
      }

      case "transfer": {
        if (!e.produced && !opts.showNullTransfers) break;
        lines.push(
          pad(e.seq, 5) +
          "  transfer " +
          padR(`${e.analysis}(${e.key}, ${e.context})`, 48) +
          (e.produced ? "→ value" : "→ undefined (no write)"),
        );
        break;
      }

      case "write": {
        if (!e.advanced && !opts.showNoops) break;
        const arrow = e.advanced ? " → " : " ≡ ";
        lines.push(
          pad(e.seq, 5) +
          "  write    " +
          padR(`${e.analysis}(${e.key}, ${e.context})`, 48) +
          `${e.oldValue}${arrow}${e.newValue}` +
          (e.advanced ? "  [ADVANCE]" : "  [noop]"),
        );
        break;
      }

      case "observe": {
        lines.push(
          pad(e.seq, 5) +
          "  observe  " +
          padR(`${e.analysis}(${e.key})`, 48) +
          `raw: ${e.rawKind}`,
        );
        break;
      }

      case "strategy": {
        lines.push(
          pad(e.seq, 5) +
          "  strategy " +
          padR(`${e.unit}  key=${e.key}  raw=${e.rawKind}`, 48) +
          (e.accepted ? "ACCEPTED" : "REJECTED") +
          `  parentCtx.depth=${e.parentContextDepth}`,
        );
        break;
      }

      case "context-extend": {
        lines.push(
          pad(e.seq, 5) +
          "  ctx+     " +
          padR(`${e.unit}  ${e.handle}:${e.key}=${e.value}`, 48) +
          `depth ${e.parentDepth} → ${e.resultDepth}  ${e.resultContext}`,
        );
        break;
      }

      case "context-exclude": {
        lines.push(
          pad(e.seq, 5) +
          "  ctx-     " +
          padR(`${e.unit}  ${e.handle}:${e.key}`, 48) +
          `depth ${e.parentDepth} → ${e.resultDepth}  ${e.resultContext}`,
        );
        break;
      }

      case "spec-context-change": {
        lines.push(
          pad(e.seq, 5) +
          "  ctx!     " +
          padR(e.unit, 48) +
          `${e.kind}  new: ${e.newContextLabel}`,
        );
        break;
      }

      case "transform-sweep": {
        lines.push(
          pad(e.seq, 5) +
          "  sweep    " +
          padR(`${e.rule}  unit: ${e.unit}`, 48) +
          (e.fired ? "FIRED → CFG rebuild scheduled" : "no-op"),
        );
        break;
      }

      case "widen-guard": {
        const lb = e.loadBearingAssumptions.length > 0
          ? `load-bearing: [${e.loadBearingAssumptions.join(", ")}]`
          : "no lineage → full widen";
        lines.push(
          pad(e.seq, 5) +
          "  widen    " +
          padR(`guard@${e.guardNodeId}  unit: ${e.unit}`, 48) +
          lb +
          (e.widenedToRoot ? "  → ROOT" : ""),
        );
        break;
      }
    }
  }

  return lines.join("\n");
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

function padR(s: string, width: number): string {
  return s.length >= width ? s + "  " : s.padEnd(width, " ");
}

// ─── Context enrichment timeline ─────────────────────────────────────────────

/** Show the enrichment history of a specific context: every cell advance that
 *  landed under `contextLabel`, in event order. Useful for answering "how did
 *  this speculative context accumulate facts over time?"
 *
 *  `contextLabel` should be the string produced by `describeContext(ctx)` —
 *  e.g. "ROOT" or "[typeNarrowing:42=number]". */
export function contextTimeline(
  events: readonly TraceEvent[],
  contextLabel: string,
): string {
  const relevant = events.filter(
    e => e.phase === "write" && (e as { context: string }).context === contextLabel,
  );

  if (relevant.length === 0) {
    return `No write events found for context "${contextLabel}"`;
  }

  const header = `Context enrichment timeline: ${contextLabel}`;
  const divider = "─".repeat(header.length);
  const lines = [header, divider];

  for (const e of relevant) {
    if (e.phase !== "write") continue;
    const marker = e.advanced ? "▲" : "·";
    lines.push(
      `${marker} #${pad(e.seq, 5)}  ${e.analysis}(${e.key})  ` +
      `${e.oldValue} → ${e.newValue}` +
      (e.advanced ? "" : "  [noop]"),
    );
  }

  return lines.join("\n");
}

// ─── Mermaid CFG diagram ──────────────────────────────────────────────────────

export interface MermaidOptions {
  /** Analyses whose .env cells to annotate on each block. Defaults to all
   *  analyses whose debugName ends in ".env". Pass [] to suppress annotations. */
  analyses?: Analysis<any, any>[];
  /** Which speculation context to read facts from. Defaults to ROOT_CONTEXT. */
  context?: AssumptionChain;
  /** Render only these units (by slot number). Defaults to all. */
  unitSlots?: number[];
}

/** Generate a Mermaid `flowchart TD` diagram of the CFG with per-block
 *  lattice annotations at the chosen context.
 *
 *  Usage:
 *    import { toMermaid } from ".../text-formatter";
 *    const diagram = toMermaid(worklist, { context: worklist.specAssumptionChainFor(unit) });
 *    // Paste into mermaid.live or a markdown block ```mermaid ... ```
 */
export function toMermaid(
  worklist: {
    readonly topology: {
      readonly units: ReadonlyMap<number, {
        readonly slot: number;
        readonly funcAst: { kind: string };
        readonly cfg: {
          readonly blocks: ReadonlyArray<{
            readonly id: number;
            readonly stmts: ReadonlyArray<unknown>;
            readonly successorEdges: ReadonlyArray<{
              readonly kind: string;
              readonly to: { readonly id: number };
            }>;
          }>;
        };
      }>;
    };
  },
  options: MermaidOptions = {},
): string {
  const ctx = options.context ?? ROOT_CONTEXT;
  const ctxLabel = describeContext(ctx);
  const lines: string[] = [`flowchart TD`];
  lines.push(`  %% context: ${ctxLabel}`);

  for (const [, unit] of worklist.topology.units) {
    if (options.unitSlots !== undefined && !options.unitSlots.includes(unit.slot)) continue;

    const unitLabel = unit.funcAst.kind === "FunctionDef"
      ? `fn_${unit.slot}`
      : `module`;

    lines.push(`  subgraph ${unitLabel}`);

    for (const block of unit.cfg.blocks) {
      const annotations: string[] = [];

      if (options.analyses !== undefined && options.analyses.length > 0) {
        for (const analysis of options.analyses) {
          const value = ctx.tryRead(analysis, block as any);
          if (value !== undefined) {
            annotations.push(`${analysis.debugName}: ${formatValue(value)}`);
          }
        }
      }

      const stmtCount = block.stmts.length;
      const label = annotations.length > 0
        ? `B${block.id}\\n${annotations.map(escapeMermaid).join("\\n")}`
        : `B${block.id} (${stmtCount} stmt${stmtCount !== 1 ? "s" : ""})`;

      lines.push(`    ${unitLabel}_B${block.id}["${label}"]`);
    }

    for (const block of unit.cfg.blocks) {
      for (const edge of block.successorEdges) {
        const edgeLabel = edge.kind === "unconditional" ? "" : `|${edge.kind}|`;
        lines.push(
          `    ${unitLabel}_B${block.id} -->${edgeLabel} ${unitLabel}_B${edge.to.id}`,
        );
      }
    }

    lines.push(`  end`);
  }

  return lines.join("\n");
}

function escapeMermaid(s: string): string {
  return s.replace(/"/g, "'").replace(/\n/g, " ").replace(/[<>]/g, m => m === "<" ? "&lt;" : "&gt;");
}
