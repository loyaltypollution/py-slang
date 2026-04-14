import { ExprNS, StmtNS } from "../../ast-types";
import { traverseAST } from "../../validator/traverse";

export type FunctionScopeNode =
  | StmtNS.FileInput
  | StmtNS.FunctionDef
  | ExprNS.Lambda
  | ExprNS.MultiLambda;

/** Observes structural events on the registry. The owning Worklist (if any)
 *  attaches itself here so that mint/retire wake downstream passes for the
 *  affected units. Registry does not know about the Worklist lifecycle API;
 *  it only dispatches "what happened to whom". */
export interface FunctionRegistryListener {
  onMint(node: FunctionScopeNode, slot: number): void;
  onRetire(fdId: number, node: FunctionScopeNode): void;
}

/**
 * Canonical owner of function identity and bytecode slot layout.
 *
 * Identity is `node.id` (stable, readonly, stamped at AST construction).
 * Slots are assigned monotonically at `mint` time and never reused within a
 * registry instance. Callers look up by either the node or the node.id; both
 * resolve to the same slot.
 *
 * ## mint / retire contract
 *
 * Structural transforms that add a FunctionDef/Lambda/MultiLambda MUST call
 * `mint`. Transforms that remove one MUST call `retire`. Skipping either
 * diverges the registry from the worklist/compiler silently and miscompiles.
 * The throws in this class convert the silent-miscompile failure mode into a
 * loud "not registered" at the first slot lookup.
 *
 * The registry's `listener` hook fires onUnitMinted/onUnitRetired for the
 * newly-minted or removed unit. Rebuilding the enclosing unit whose body
 * structurally changed is handled by the worklist's transform sweep: a
 * `TransformRule.sweep` that mutates the enclosing unit returns `true`, and
 * the worklist schedules the rebuild automatically.
 */
export class FunctionRegistry {
  private nextSlot = 0;
  private readonly byFdId = new Map<number, { node: FunctionScopeNode; slot: number }>();
  private readonly nodeToFdId = new WeakMap<FunctionScopeNode, number>();
  private listener: FunctionRegistryListener | undefined;

  /** Attach the single structural-event listener (the owning Worklist).
   *  Replaces any prior listener. Pass `undefined` to detach. */
  setListener(listener: FunctionRegistryListener | undefined): void {
    this.listener = listener;
  }

  /** Allocate and record a slot for `node`. Throws if already registered. */
  mint(node: FunctionScopeNode): number {
    if (this.nodeToFdId.has(node)) {
      throw new Error(`FunctionRegistry: node id=${node.id} already registered`);
    }
    const slot = this.nextSlot++;
    this.byFdId.set(node.id, { node, slot });
    this.nodeToFdId.set(node, node.id);
    this.listener?.onMint(node, slot);
    return slot;
  }

  /** Remove `fdId` from the registry. Slot number is not reused. */
  retire(fdId: number): void {
    const entry = this.byFdId.get(fdId);
    if (!entry) {
      throw new Error(`FunctionRegistry: fdId=${fdId} not registered`);
    }
    this.byFdId.delete(fdId);
    this.nodeToFdId.delete(entry.node);
    this.listener?.onRetire(fdId, entry.node);
  }

  slotOf(fdId: number): number {
    const entry = this.byFdId.get(fdId);
    if (!entry) {
      throw new Error(`FunctionRegistry: fdId=${fdId} not registered`);
    }
    return entry.slot;
  }

  slotOfNode(node: FunctionScopeNode): number {
    return this.slotOf(node.id);
  }

  nodeOf(fdId: number): FunctionScopeNode {
    const entry = this.byFdId.get(fdId);
    if (!entry) {
      throw new Error(`FunctionRegistry: fdId=${fdId} not registered`);
    }
    return entry.node;
  }

  has(fdId: number): boolean {
    return this.byFdId.has(fdId);
  }

  hasNode(node: FunctionScopeNode): boolean {
    return this.nodeToFdId.has(node);
  }

  /** Snapshot of `fdId → slot` for tests and debugging. */
  snapshot(): ReadonlyMap<number, number> {
    const out = new Map<number, number>();
    for (const [fdId, entry] of this.byFdId) out.set(fdId, entry.slot);
    return out;
  }

  /** Iterate entries in mint order (slot-ascending). Map iteration is
   *  insertion-order, and `mint` assigns `nextSlot++`, so this matches
   *  slot order without an explicit sort — `retire` only removes entries,
   *  it does not reorder survivors. */
  *entries(): IterableIterator<{ fdId: number; node: FunctionScopeNode; slot: number }> {
    for (const [fdId, { node, slot }] of this.byFdId) yield { fdId, node, slot };
  }

  get size(): number {
    return this.byFdId.size;
  }
}

/**
 * Build a fresh registry by pre-order DFS over `program`: FileInput first,
 * then nested FunctionDef/Lambda/MultiLambda in traversal order. Slot order
 * is byte-identical to the legacy `computeFunctionIndices` pass, so bytecode
 * layout is preserved during the migration.
 */
export function buildFunctionRegistry(program: StmtNS.FileInput): FunctionRegistry {
  const registry = new FunctionRegistry();
  registry.mint(program);
  traverseAST(program, node => {
    if (
      node instanceof StmtNS.FunctionDef ||
      node instanceof ExprNS.Lambda ||
      node instanceof ExprNS.MultiLambda
    ) {
      registry.mint(node);
    }
  });
  return registry;
}
