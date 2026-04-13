import type { QueryHandle } from "./query";
import type { InputHandle } from "./input";
import { Cell, makeCell } from "./cell";
import { Revision, REVISION_ZERO } from "./revision";

interface StackFrame {
  cellId: string;
  queryId: symbol;
  deps: string[];
}

const MAX_CYCLE_ITERATIONS = 200;

export class Db {
  private cells = new Map<string, Cell<unknown>>();
  private reverseIndex = new Map<string, Set<string>>();
  private queryStack: StackFrame[] = [];
  private recomputers = new Map<string, () => void>();
  private names = new Set<string>();
  private revision: Revision = REVISION_ZERO;

  currentRevision(): Revision {
    return this.revision;
  }

  cellIdFor<Args>(
    handle: { id: symbol; serialize: (a: Args) => string },
    args: Args,
  ): string {
    return (handle.id.description ?? '') + '::' + handle.serialize(args);
  }

  dependentsOf(cellId: string): ReadonlySet<string> {
    return this.reverseIndex.get(cellId) ?? new Set<string>();
  }

  depsOf(cellId: string): readonly string[] {
    return this.cells.get(cellId)?.deps ?? [];
  }

  get<Args, V>(query: QueryHandle<Args, V>, args: Args): V {
    this.names.add(query.name);
    const id = this.cellIdFor(query, args);

    const top = this.queryStack[this.queryStack.length - 1];
    if (top !== undefined) top.deps.push(id);

    const existing = this.cells.get(id) as Cell<V> | undefined;

    if (existing === undefined || existing.state === 'uninit') {
      return this.recompute<Args, V>(query, args, id);
    }

    if (existing.state === 'green') {
      return existing.value;
    }

    if (existing.state === 'computing') {
      // Every frame on queryStack has its cell in 'computing' state, so top is the innermost.
      if (top === undefined || top.queryId !== query.id) {
        throw new Error(
          'Cross-query cycle detected: re-entered query ' + query.name +
          ' while computing ' + String(top?.cellId),
        );
      }
      if (!query.isCyclic) {
        throw new Error('Unexpected cycle in non-cyclic query: ' + id);
      }
      return existing.value;
    }

    return this.revalidate<Args, V>(query, args, id, existing);
  }

  writeInput<K, V>(input: InputHandle<K, V>, key: K, value: V): void {
    this.names.add(input.name);
    const id = this.cellIdFor({ id: input.id, serialize: input.serialize }, key);
    const existing = this.cells.get(id) as Cell<V> | undefined;

    if (existing !== undefined && existing.state !== 'uninit' && input.lattice.equals(existing.value, value)) {
      return;
    }

    this.revision = ((this.revision as number) + 1) as Revision;

    this.cells.set(id, {
      value,
      computedAt: this.revision,
      changedAt: this.revision,
      deps: [],
      state: 'green',
    } as Cell<unknown>);
    this.invalidateDependents(id);
  }

  readRaw<V>(cellId: string, bottom: V): V {
    const cell = this.cells.get(cellId) as Cell<V> | undefined;
    if (cell === undefined || cell.state === 'uninit') return bottom;
    return cell.value;
  }

  private revalidate<Args, V>(
    query: QueryHandle<Args, V>,
    args: Args,
    id: string,
    cell: Cell<V>,
  ): V {
    for (const depId of cell.deps) {
      if (!this.cells.has(depId)) {
        return this.recompute<Args, V>(query, args, id);
      }
      this.recomputers.get(depId)?.();
      const after = this.cells.get(depId);
      if (after === undefined || (after.changedAt as number) > (cell.computedAt as number)) {
        return this.recompute<Args, V>(query, args, id);
      }
    }
    cell.state = 'green';
    return cell.value;
  }

  private recompute<Args, V>(
    query: QueryHandle<Args, V>,
    args: Args,
    id: string,
  ): V {
    const prior = this.cells.get(id) as Cell<V> | undefined;
    const hadPriorValue = prior !== undefined && prior.state !== 'uninit' && prior.state !== 'computing';
    const priorValue = hadPriorValue ? prior!.value : undefined;

    const cell: Cell<V> = prior ?? makeCell<V>(query.lattice.bottom);
    if (prior === undefined) this.cells.set(id, cell as Cell<unknown>);
    cell.state = 'computing';

    this.recomputers.set(id, () => { this.get(query, args); });

    const frame: StackFrame = { cellId: id, queryId: query.id, deps: [] };
    this.queryStack.push(frame);

    let newValue: V;
    try {
      if (query.isCyclic) {
        cell.value = query.lattice.bottom;
        let current = query.lattice.bottom;
        for (let iter = 0; ; iter++) {
          if (iter >= MAX_CYCLE_ITERATIONS) {
            throw new Error('Cycle fixpoint did not converge: ' + id);
          }
          const next = query.fn(this, args);
          if (query.lattice.equals(current, next)) {
            newValue = current;
            break;
          }
          current = query.lattice.join(current, next);
          cell.value = current;
        }
      } else {
        newValue = query.fn(this, args);
      }
    } finally {
      this.queryStack.pop();
    }

    const oldDeps = cell.deps;
    cell.value = newValue;
    cell.computedAt = this.revision;
    cell.deps = frame.deps;
    cell.state = 'green';
    this.updateReverseIndex(id, oldDeps, frame.deps);

    if (hadPriorValue && query.lattice.equals(priorValue as V, newValue)) {
      // Early cutoff: value unchanged, so changedAt stays put and downstream stays green.
      return cell.value;
    }

    cell.changedAt = this.revision;
    if (hadPriorValue) this.invalidateDependents(id);
    return cell.value;
  }

  private updateReverseIndex(cellId: string, oldDeps: readonly string[], newDeps: readonly string[]): void {
    const oldSet = new Set(oldDeps);
    const newSet = new Set(newDeps);
    for (const d of oldDeps) {
      if (!newSet.has(d)) this.reverseIndex.get(d)?.delete(cellId);
    }
    for (const d of newDeps) {
      if (oldSet.has(d)) continue;
      let s = this.reverseIndex.get(d);
      if (s === undefined) {
        s = new Set<string>();
        this.reverseIndex.set(d, s);
      }
      s.add(cellId);
    }
  }

  private invalidateDependents(rootId: string): void {
    const seen = new Set<string>();
    const queue: string[] = [...(this.reverseIndex.get(rootId) ?? [])];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      const cell = this.cells.get(id);
      if (cell === undefined || cell.state === 'red') continue;
      cell.state = 'red';
      const deps = this.reverseIndex.get(id);
      if (deps !== undefined) for (const d of deps) queue.push(d);
    }
  }
}
