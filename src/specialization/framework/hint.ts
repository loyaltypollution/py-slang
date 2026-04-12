import type { TypeLattice } from "../type-analysis/lattice";
import type { ConstLattice } from "../const-analysis/lattice";
import type { ExprNS, StmtNS } from "../../ast-types";

/**
 * Typed key under which an analysis stores its lattice value in a hint record.
 *
 * Each `AnalysisModule` exports a key; transforms and consumers that want an
 * analysis-specific value read it via `HintStore.getTyped(node, key)` or
 * `hintGet(hint, key)`. This is the extensibility seam — a new analysis adds
 * a key and nothing else in the framework needs to know about it.
 */
export interface AnalysisKey<L = unknown> {
  readonly name: string;
  equals(a: L, b: L): boolean;
}

/**
 * Open record of analysis values keyed by `AnalysisKey.name`.
 *
 * The named `type` and `constVal` fields are conveniences for the two analyses
 * currently shipped; they are equivalent to reading under the corresponding
 * analysis key's name. New analyses do not need to extend this interface —
 * they add their value under their own key via the index signature.
 */
export interface OptimizationHint {
  readonly [fieldName: string]: unknown;
  readonly type?: TypeLattice;
  readonly constVal?: ConstLattice;
}

/** Typed accessor on a plain hint record. */
export function hintGet<L>(
  hint: OptimizationHint | undefined,
  key: AnalysisKey<L>,
): L | undefined {
  return hint ? (hint[key.name] as L | undefined) : undefined;
}

/** Functional setter: returns a new hint record with `key.name` set to `value`. */
export function hintSet<L>(
  hint: OptimizationHint,
  key: AnalysisKey<L>,
  value: L,
): OptimizationHint {
  return { ...hint, [key.name]: value };
}

// ── Built-in analysis keys ────────────────────────────────────────────────────
//
// These are defined here (rather than in the analysis modules) so that
// `HintStore` can default-register them without importing from the analysis
// packages. Analysis modules re-export these constants as their `.key`.

export const TYPE_ANALYSIS_KEY: AnalysisKey<TypeLattice> = {
  name: "type",
  equals: typeLatticeEquals,
};

export const CONST_ANALYSIS_KEY: AnalysisKey<ConstLattice> = {
  name: "constVal",
  equals: constLatticeEquals,
};

function defaultAnalysisKeys(): readonly AnalysisKey<unknown>[] {
  return [TYPE_ANALYSIS_KEY as AnalysisKey<unknown>, CONST_ANALYSIS_KEY as AnalysisKey<unknown>];
}

export interface HintChangeRecord {
  readonly nodeId: number;
  readonly version: number;
  readonly oldHint: OptimizationHint | undefined;
  readonly newHint: OptimizationHint;
}

// ── Lattice equality ──────────────────────────────────────────────────────────

export function typeLatticeEquals(a: TypeLattice, b: TypeLattice): boolean {
  return (
    a === b ||
    (a.kinds === b.kinds && a.intRef === b.intRef && a.boolRef === b.boolRef && a.floatRef === b.floatRef)
  );
}

export function constLatticeEquals(a: ConstLattice, b: ConstLattice): boolean {
  return a === b || (a.tag !== "const" ? a.tag === b.tag : b.tag === "const" && a.value === b.value);
}

/**
 * Compare two hint records by iterating the union of their fields and
 * consulting the registered `AnalysisKey` for each. Fields without a
 * registered key fall back to strict equality (conservative: over-invalidates
 * rather than under-invalidates).
 */
export function hintEquals(
  a: OptimizationHint,
  b: OptimizationHint,
  registry: ReadonlyMap<string, AnalysisKey<unknown>> = DEFAULT_KEY_REGISTRY,
): boolean {
  const names = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  for (const name of names) {
    const av = a[name];
    const bv = b[name];
    if (av === bv) continue;
    if (av === undefined || bv === undefined) return false;
    const key = registry.get(name);
    if (!key) return false;
    if (!key.equals(av, bv)) return false;
  }
  return true;
}

const DEFAULT_KEY_REGISTRY: ReadonlyMap<string, AnalysisKey<unknown>> = (() => {
  const m = new Map<string, AnalysisKey<unknown>>();
  m.set(TYPE_ANALYSIS_KEY.name, TYPE_ANALYSIS_KEY as AnalysisKey<unknown>);
  m.set(CONST_ANALYSIS_KEY.name, CONST_ANALYSIS_KEY as AnalysisKey<unknown>);
  return m;
})();

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
  private readonly registry: ReadonlyMap<string, AnalysisKey<unknown>>;

  /**
   * @param keys Analysis keys known to this store; used by `hintEquals` to
   * compare field values. Unknown fields fall back to strict equality.
   * Defaults to built-in keys (`type`, `constVal`) for call-sites that build
   * a store without a specific analysis registry.
   */
  constructor(keys: readonly AnalysisKey<unknown>[] = defaultAnalysisKeys()) {
    const m = new Map<string, AnalysisKey<unknown>>();
    for (const k of keys) m.set(k.name, k);
    this.registry = m;
  }

  get version(): number {
    return this._version;
  }

  get(node: ExprNS.Expr | StmtNS.Stmt): OptimizationHint | undefined {
    return this.map.get(node.id);
  }

  /** Look up a hint by raw node id (used by the observation handler). */
  getById(id: number): OptimizationHint | undefined {
    return this.map.get(id);
  }

  /** Typed lookup: returns this analysis's lattice value under its key. */
  getTyped<L>(node: ExprNS.Expr | StmtNS.Stmt, key: AnalysisKey<L>): L | undefined {
    return hintGet(this.map.get(node.id), key);
  }

  /** Returns true if the value actually changed. */
  set(node: ExprNS.Expr | StmtNS.Stmt, hint: OptimizationHint): boolean {
    return this.setById(node.id, hint);
  }

  /** Set a hint by raw node id. Returns true if value changed. */
  setById(id: number, hint: OptimizationHint): boolean {
    const old = this.map.get(id);
    if (old !== undefined && hintEquals(old, hint, this.registry)) return false;
    this._version++;
    this._changes.push({ nodeId: id, version: this._version, oldHint: old, newHint: hint });
    this.map.set(id, hint);
    return true;
  }

  /** Copy all entries from this store into `target`, overwriting on conflict. */
  mergeInto(target: HintStore): void {
    for (const [id, hint] of this.map) {
      target.setById(id, hint);
    }
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
