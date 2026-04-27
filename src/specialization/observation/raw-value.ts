export type RawKind =
  | { kind: "number"; value: number }
  | { kind: "bool"; value: boolean }
  | { kind: "string"; value: string | undefined }
  | { kind: "none" }
  | { kind: "closure" }
  | { kind: "complex" }
  | { kind: "unknown" };

const NONE: RawKind = { kind: "none" };
const CLOSURE: RawKind = { kind: "closure" };
const COMPLEX: RawKind = { kind: "complex" };
export const RAW_UNKNOWN: RawKind = { kind: "unknown" };

export function classifyRawValue(raw: unknown): RawKind {
  if (raw === null || raw === undefined) return NONE;
  if (typeof raw === "number") return { kind: "number", value: raw };
  if (typeof raw === "boolean") return { kind: "bool", value: raw };
  if (typeof raw === "string") return { kind: "string", value: raw };
  if (typeof raw === "bigint") return { kind: "number", value: Number(raw) };
  if (typeof raw !== "object") return RAW_UNKNOWN;

  const tagged = raw as { type?: string; value?: unknown };
  switch (tagged.type) {
    case "number":
      return typeof tagged.value === "number"
        ? { kind: "number", value: tagged.value }
        : RAW_UNKNOWN;
    case "bigint":
      return typeof tagged.value === "bigint"
        ? { kind: "number", value: Number(tagged.value) }
        : RAW_UNKNOWN;
    case "bool":
      return typeof tagged.value === "boolean"
        ? { kind: "bool", value: tagged.value }
        : RAW_UNKNOWN;
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
      return RAW_UNKNOWN;
  }
}
