import type { TypeLattice } from "../type-analysis/lattice";
import type { ConstLattice } from "../const-analysis/lattice";
import type { ExprNS, StmtNS } from "../../ast-types";

/**
 * Open record of analysis values keyed by `AnalysisModule.name`. Built-in
 * analyses write to the named fields below; a new analysis adds an
 * optional field here and exposes the same name on its module.
 */
export interface OptimizationHint {
  readonly [fieldName: string]: unknown;
  readonly type?: TypeLattice;
  readonly constVal?: ConstLattice;
}

// ── Built-in lattice equality helpers ────────────────────────────────────────

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
 * Minimum shape the `HintStore` registry needs: a field name and a
 * per-field lattice equality. `AnalysisModule` extends this, so the store
 * can register modules directly.
 */
export interface LatticeEquality {
  readonly name: string;
  latticeEquals(a: unknown, b: unknown): boolean;
}

const DEFAULT_REGISTRY_ENTRIES: readonly LatticeEquality[] = [
  {
    name: "type",
    latticeEquals: (a, b) => typeLatticeEquals(a as TypeLattice, b as TypeLattice),
  },
  {
    name: "constVal",
    latticeEquals: (a, b) => constLatticeEquals(a as ConstLattice, b as ConstLattice),
  },
];

function buildRegistry(
  entries: readonly LatticeEquality[],
): ReadonlyMap<string, LatticeEquality> {
  const m = new Map<string, LatticeEquality>();
  for (const e of entries) m.set(e.name, e);
  return m;
}

let _defaultRegistry: ReadonlyMap<string, LatticeEquality> | undefined;
function defaultRegistry(): ReadonlyMap<string, LatticeEquality> {
  return (_defaultRegistry ??= buildRegistry(DEFAULT_REGISTRY_ENTRIES));
}

/**
 * Compare two hint records by iterating the union of their fields and
 * consulting the registered module for each. Fields without a registered
 * module fall back to strict equality (conservative: over-invalidates
 * rather than under-invalidates).
 */
export function hintEquals(
  a: OptimizationHint,
  b: OptimizationHint,
  registry: ReadonlyMap<string, LatticeEquality> = defaultRegistry(),
): boolean {
  const names = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  for (const name of names) {
    const av = a[name];
    const bv = b[name];
    if (av === bv) continue;
    if (av === undefined || bv === undefined) return false;
    const entry = registry.get(name);
    if (!entry) return false;
    if (!entry.latticeEquals(av, bv)) return false;
  }
  return true;
}

/**
 * Map-based hint storage keyed by node.id. Analysis visitors call
 * `hints.get(node)` / `hints.set(node, hint)`. Equality on write suppresses
 * no-op updates.
 */
export class HintStore {
  private readonly map = new Map<number, OptimizationHint>();
  private readonly registry: ReadonlyMap<string, LatticeEquality>;

  constructor(modules: readonly LatticeEquality[] = DEFAULT_REGISTRY_ENTRIES) {
    this.registry = buildRegistry(modules);
  }

  get(node: ExprNS.Expr | StmtNS.Stmt): OptimizationHint | undefined {
    return this.map.get(node.id);
  }

  getById(id: number): OptimizationHint | undefined {
    return this.map.get(id);
  }

  set(node: ExprNS.Expr | StmtNS.Stmt, hint: OptimizationHint): boolean {
    return this.setById(node.id, hint);
  }

  setById(id: number, hint: OptimizationHint): boolean {
    const old = this.map.get(id);
    if (old !== undefined && hintEquals(old, hint, this.registry)) return false;
    this.map.set(id, hint);
    return true;
  }

  /** Iterate (nodeId, hint) entries. */
  [Symbol.iterator](): IterableIterator<[number, OptimizationHint]> {
    return this.map.entries();
  }
}
