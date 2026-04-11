import type { TypeLattice } from "../type-analysis/lattice";
import type { ConstLattice } from "../const-analysis/lattice";
import type { ExprNS, StmtNS } from "../../ast-types";

export interface OptimizationHint {
  type?: TypeLattice;
  constVal?: ConstLattice;
}

export interface HintChangeRecord {
  readonly nodeId: number;
  readonly version: number;
  readonly oldHint: OptimizationHint | undefined;
  readonly newHint: OptimizationHint;
}

// ── Lattice equality ──────────────────────────────────────────────────────────

function typeLatticeEquals(a: TypeLattice, b: TypeLattice): boolean {
  return (
    a === b ||
    (a.kinds === b.kinds && a.intRef === b.intRef && a.boolRef === b.boolRef && a.floatRef === b.floatRef)
  );
}

function constLatticeEquals(a: ConstLattice, b: ConstLattice): boolean {
  return a === b || (a.tag !== "const" ? a.tag === b.tag : b.tag === "const" && a.value === b.value);
}

export function hintEquals(a: OptimizationHint, b: OptimizationHint): boolean {
  // Compare .type fields
  if (a.type !== b.type) {
    if (!a.type || !b.type || !typeLatticeEquals(a.type, b.type)) return false;
  }
  // Compare .constVal fields
  if (a.constVal !== b.constVal) {
    if (!a.constVal || !b.constVal || !constLatticeEquals(a.constVal, b.constVal)) return false;
  }
  return true;
}

// ── HintStore ─────────────────────────────────────────────────────────────────

/**
 * Map-based hint storage keyed by node.id.
 *
 * Analysis visitors call `hints.get(node)` / `hints.set(node, hint)`.
 * Version tracking: each mutation that actually changes a value bumps the
 * version counter and appends to the change log.
 */
export class HintStore {
  private readonly map = new Map<number, OptimizationHint>();
  private _version = 0;
  private readonly _changes: HintChangeRecord[] = [];

  get version(): number {
    return this._version;
  }

  get(node: ExprNS.Expr | StmtNS.Stmt): OptimizationHint | undefined {
    return this.map.get(node.id);
  }

  /** Returns true if the value actually changed. */
  set(node: ExprNS.Expr | StmtNS.Stmt, hint: OptimizationHint): boolean {
    const old = this.map.get(node.id);
    if (old !== undefined && hintEquals(old, hint)) return false;
    this._version++;
    this._changes.push({ nodeId: node.id, version: this._version, oldHint: old, newHint: hint });
    this.map.set(node.id, hint);
    return true;
  }

  /** Copy all entries from this store into `target`, overwriting on conflict. */
  mergeInto(target: HintStore): void {
    for (const [id, hint] of this.map) {
      target.setById(id, hint);
    }
  }

  /** Set a hint by raw node id (used by mergeInto). Returns true if value changed. */
  setById(id: number, hint: OptimizationHint): boolean {
    const old = this.map.get(id);
    if (old !== undefined && hintEquals(old, hint)) return false;
    this._version++;
    this._changes.push({ nodeId: id, version: this._version, oldHint: old, newHint: hint });
    this.map.set(id, hint);
    return true;
  }

  /** Returns all changes since the given version (exclusive). */
  changesSince(version: number): ReadonlyArray<HintChangeRecord> {
    // Binary search for the first change with version > requested
    let lo = 0;
    let hi = this._changes.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this._changes[mid].version <= version) lo = mid + 1;
      else hi = mid;
    }
    return this._changes.slice(lo);
  }
}
