import type { StmtNS } from "../../../ast-types";

export function countNodes(stmts: readonly StmtNS.Stmt[]): number {
  let n = 0;
  const walk = (v: unknown): void => {
    if (v === null || typeof v !== "object") return;
    if (typeof (v as { id?: unknown }).id === "number") n++;
    for (const k of Object.keys(v as object)) {
      const child = (v as Record<string, unknown>)[k];
      if (Array.isArray(child)) for (const c of child) walk(c);
      else if (typeof child === "object") walk(child);
    }
  };
  for (const s of stmts) walk(s);
  return n;
}
