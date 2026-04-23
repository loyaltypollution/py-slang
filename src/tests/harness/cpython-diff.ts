import { spawnSync } from "child_process";

export interface PythonResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

export function runPython3(code: string, timeoutMs = DEFAULT_TIMEOUT_MS): PythonResult {
  const res = spawnSync("python3", ["-c", code], {
    encoding: "utf-8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    stdout: normalizeOutput(res.stdout ?? ""),
    stderr: res.stderr ?? "",
    exitCode: res.status ?? (res.error ? 1 : 0),
  };
}

export function normalizeOutput(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\s+$/, "");
}

// Known py-slang → CPython print-repr divergences that are orthogonal to the
// specialization pipeline: bool casing (py-slang emits JS `true`/`false`).
// Normalising these keeps the differential harness focused on specialization
// regressions without getting stuck on pre-existing codegen gaps. Remove
// entries as the repr layer is fixed.
export function normalizePyslangOutput(s: string): string {
  return normalizeOutput(s)
    .replace(/(^|\s)true(\s|$)/g, "$1True$2")
    .replace(/(^|\s)false(\s|$)/g, "$1False$2");
}

// Env gate: CPython differential assertions only run when PYSLANG_DIFF=1.
// Keeps `yarn test` green on machines without python3 and avoids coupling CI
// green-light to a python install step until the workflow is updated.
export const DIFF_ENABLED = process.env.PYSLANG_DIFF === "1";
