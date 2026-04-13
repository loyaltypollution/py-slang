import type { ExprNS, StmtNS } from "../../ast-types";
import type { TypeLattice } from "../type-analysis/lattice";
import type { ConstLattice } from "../const-analysis/lattice";
import { FactStore } from "./fact-store";
import { createHintPasses, type HintPasses } from "./hint-passes";
import type { Pass } from "./pass";

/**
 * Closed record of analysis values. Each field is written by a specific pass;
 * equality on a field is dispatched through the owning pass's
 * `lattice.equals`, wired from `FieldEquals` at construction.
 *
 * Two algebras coexist here:
 *   - *Lattice* fields (`type`, `constVal`) — written by an `AnalysisPass`
 *     during DFA.
 *   - *Scope-summary* fields (`callCount`, `pure`) — written by a
 *     `ScopePass` from runtime observations or a scope-level fold.
 */
export interface OptimizationHint {
  readonly type?: TypeLattice;
  readonly constVal?: ConstLattice;
  readonly callCount?: number;
  readonly pure?: boolean;
}

export type HintField = keyof OptimizationHint;

/** Equality on one hint field. Never called with `undefined` on either side. */
export type FieldEquals = (a: unknown, b: unknown) => boolean;

const HINT_FIELDS: readonly HintField[] = ["type", "constVal", "callCount", "pure"];

/**
 * Thin facade over a `FactStore`: each `HintField` is backed by a
 * `Pass<number, V>` registered in the store, and every read/write routes
 * through it. Write dedup is delegated to `FactStore.write`, which gates on
 * `pass.lattice.equals` — the facade holds no separate map or dedup state.
 *
 * Two construction modes:
 *   - Standalone (no args / only `fieldEq`): a private `FactStore` is
 *     allocated. Used by tests and any caller that wants a detached hint
 *     collection.
 *   - Worklist-owned (`factStore` supplied): hints share the worklist's
 *     fact store, so the pass-graph dispatch mechanism sees hint writes as
 *     regular fact changes.
 *
 * Passes are per-instance: `FieldEquals` is a construction-time parameter
 * that must bind into each pass's lattice, so passes carry a fresh symbolic
 * identity per `HintStore`. That also means one `FactStore` cleanly
 * partitions cells across multiple `HintStore`s that share it.
 */
export class HintStore {
  private readonly factStore: FactStore;
  private readonly passes: HintPasses;

  constructor(
    factStoreOrFieldEq?: FactStore | ReadonlyMap<string, FieldEquals>,
    fieldEq: ReadonlyMap<string, FieldEquals> = new Map(),
  ) {
    if (factStoreOrFieldEq instanceof FactStore) {
      this.factStore = factStoreOrFieldEq;
      this.passes = createHintPasses(fieldEq);
    } else {
      this.factStore = new FactStore();
      this.passes = createHintPasses(factStoreOrFieldEq ?? fieldEq);
    }
  }

  get(node: ExprNS.Expr | StmtNS.Stmt): OptimizationHint | undefined {
    return this.getById(node.id);
  }

  getById(id: number): OptimizationHint | undefined {
    const hint: Record<string, unknown> = {};
    let any = false;
    for (const field of HINT_FIELDS) {
      const pass = this.passes[field] as Pass<number, unknown>;
      if (!this.factStore.has(pass, id)) continue;
      const v = this.factStore.read(pass, id);
      if (v === undefined) continue;
      hint[field] = v;
      any = true;
    }
    return any ? (hint as OptimizationHint) : undefined;
  }

  set(node: ExprNS.Expr | StmtNS.Stmt, hint: OptimizationHint): boolean {
    return this.setById(node.id, hint);
  }

  /**
   * Merge each defined field of `hint` into the store. Returns `true` iff
   * any field's value changed under its pass's lattice equality. Fields
   * absent from `hint` are left untouched (this matches the pre-facade
   * behavior — `setById` was used as a partial merge by callers).
   */
  setById(id: number, hint: OptimizationHint): boolean {
    let changed = false;
    for (const field of HINT_FIELDS) {
      const v = hint[field];
      if (v === undefined) continue;
      if (this.writeField(id, field, v)) changed = true;
    }
    return changed;
  }

  /**
   * Write a single field. Returns true iff the stored value changed.
   */
  updateField<K extends HintField>(
    id: number,
    field: K,
    value: NonNullable<OptimizationHint[K]>,
  ): boolean {
    return this.writeField(id, field, value);
  }

  private writeField(id: number, field: HintField, value: unknown): boolean {
    const pass = this.passes[field] as unknown as Parameters<FactStore["write"]>[0];
    return this.factStore.write(pass, id, value);
  }

  [Symbol.iterator](): IterableIterator<[number, OptimizationHint]> {
    const ids = new Set<number>();
    for (const field of HINT_FIELDS) {
      const pass = this.passes[field] as Pass<number, unknown>;
      for (const id of this.factStore.readAll(pass).keys()) {
        ids.add(id);
      }
    }
    const entries: Array<[number, OptimizationHint]> = [];
    for (const id of ids) {
      const h = this.getById(id);
      if (h !== undefined) entries.push([id, h]);
    }
    return entries[Symbol.iterator]();
  }
}
