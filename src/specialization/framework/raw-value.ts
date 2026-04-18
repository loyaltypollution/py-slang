// Normalizes raw runtime-observed values (from `runtimeWriteAnalysis`) into a
// tagged union that lattice-lifters can dispatch on. Hides the tagged-object
// shape of CSE stack values so each analysis maps one classification.

export type RawKind =
  | { kind: "number"; value: number }
  | { kind: "bool"; value: boolean }
  | { kind: "string"; value: string | undefined }
  | { kind: "none" }
  | { kind: "closure" }
  | { kind: "complex" }
  | { kind: "unknown" };

// Interned no-payload singletons. Observation of `None`, closures, complexes,
// and unclassifiable values never allocates.
const NONE: RawKind = { kind: "none" };
const CLOSURE: RawKind = { kind: "closure" };
const COMPLEX: RawKind = { kind: "complex" };
const UNKNOWN: RawKind = { kind: "unknown" };

// One-slot last-seen memo. SVML fires observations with raw JS primitives
// (Smis / floats / interned strings), and the same primitive is re-observed
// every iteration of a hot loop. Without memoization, each fire allocates a
// fresh `{kind,value}` wrapper — the wrapper then compares structurally-equal
// to the stored one and the write no-ops, but the allocation is pure churn.
// Guarding by `raw === lastRaw` recovers SVML's primitive fast path
// (zero allocation, single reference check) without leaking engine-specific
// knowledge into the lattice or the sink.
let lastRaw: unknown = Symbol("cache-miss-sentinel");
let lastKind: RawKind = UNKNOWN;

export function classifyRawValue(raw: unknown): RawKind {
  if (raw === lastRaw) return lastKind;
  const classified = classifyRawValueUncached(raw);
  lastRaw = raw;
  lastKind = classified;
  return classified;
}

function classifyRawValueUncached(raw: unknown): RawKind {
  if (raw === null || raw === undefined) return NONE;
  if (typeof raw === "number") return { kind: "number", value: raw };
  if (typeof raw === "boolean") return { kind: "bool", value: raw };
  if (typeof raw === "string") return { kind: "string", value: raw };
  if (typeof raw === "bigint") return { kind: "number", value: Number(raw) };
  if (typeof raw !== "object") return UNKNOWN;

  const tagged = raw as { type?: string; value?: unknown };
  switch (tagged.type) {
    case "number":
      return typeof tagged.value === "number"
        ? { kind: "number", value: tagged.value }
        : UNKNOWN;
    case "bigint":
      return typeof tagged.value === "bigint"
        ? { kind: "number", value: Number(tagged.value) }
        : UNKNOWN;
    case "bool":
      return typeof tagged.value === "boolean"
        ? { kind: "bool", value: tagged.value }
        : UNKNOWN;
    case "string":
      return { kind: "string", value: typeof tagged.value === "string" ? tagged.value : undefined };
    case "none":
      return NONE;
    case "closure":
    case "function":
    case "multi_lambda":
    case "builtin":
      return CLOSURE;
    case "complex":
      return COMPLEX;
    default:
      return UNKNOWN;
  }
}
