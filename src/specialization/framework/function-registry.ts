import { ExprNS, StmtNS } from "../../ast-types";
import { traverseAST } from "../../validator/traverse";
import { Speculation, ROOT_CONTEXT, isRoot } from "./assumption-chain";

export type FunctionScopeNode =
  | StmtNS.FileInput
  | StmtNS.FunctionDef
  | ExprNS.Lambda
  | ExprNS.MultiLambda;

/** Observes structural events on the registry. The owning Worklist (if
 *  any) attaches itself so that mint wakes downstream analyses. */
export interface FunctionRegistryListener {
  onMint(node: FunctionScopeNode, slot: number): void;
}

/**
 * Canonical owner of function identity and bytecode slot layout.
 *
 * Identity is `node.id` (stable, readonly). Slots are assigned monotonically
 * at `mint` time and never reused. Structural transforms that add a
 * FunctionDef/Lambda/MultiLambda MUST call `mint`.
 *
 * ROOT-only invariant: `mint` requires `chain === ROOT_CONTEXT`. Slots and
 * functionIds have no chain dimension, so a non-ROOT structural rewrite
 * would publish a function visible to every sibling chain.
 */
export class FunctionRegistry {
  private nextSlot = 0;
  private readonly byFunctionId = new Map<number, { node: FunctionScopeNode; slot: number }>();
  private readonly nodeToFunctionId = new WeakMap<FunctionScopeNode, number>();
  private listener: FunctionRegistryListener | undefined;

  setListener(listener: FunctionRegistryListener | undefined): void {
    this.listener = listener;
  }

  mint(node: FunctionScopeNode, chain: Speculation): number {
    if (!isRoot(chain)) {
      throw new Error(
        `FunctionRegistry.mint: structural rewrites are ROOT-only (chain depth=${chain.depth}).`,
      );
    }
    if (this.nodeToFunctionId.has(node)) {
      throw new Error(`FunctionRegistry: node id=${node.id} already registered`);
    }
    const slot = this.nextSlot++;
    this.byFunctionId.set(node.id, { node, slot });
    this.nodeToFunctionId.set(node, node.id);
    this.listener?.onMint(node, slot);
    return slot;
  }

  slotOf(functionId: number): number {
    const entry = this.byFunctionId.get(functionId);
    if (!entry) {
      throw new Error(`FunctionRegistry: functionId=${functionId} not registered`);
    }
    return entry.slot;
  }

  slotOfNode(node: FunctionScopeNode): number {
    return this.slotOf(node.id);
  }

  hasNode(node: FunctionScopeNode): boolean {
    return this.nodeToFunctionId.has(node);
  }

  /** Snapshot of `functionId → slot` for tests and debugging. */
  snapshot(): ReadonlyMap<number, number> {
    const out = new Map<number, number>();
    for (const [functionId, { slot }] of this.byFunctionId) out.set(functionId, slot);
    return out;
  }

  /** Iterate entries in mint order (slot-ascending). */
  *entries(): IterableIterator<{ functionId: number; node: FunctionScopeNode; slot: number }> {
    for (const [functionId, { node, slot }] of this.byFunctionId) yield { functionId, node, slot };
  }

  get size(): number {
    return this.byFunctionId.size;
  }
}

/** Build a fresh registry by pre-order DFS over `program`. */
export function buildFunctionRegistry(program: StmtNS.FileInput): FunctionRegistry {
  const registry = new FunctionRegistry();
  registry.mint(program, ROOT_CONTEXT);
  traverseAST(program, node => {
    if (
      node instanceof StmtNS.FunctionDef ||
      node instanceof ExprNS.Lambda ||
      node instanceof ExprNS.MultiLambda
    ) {
      registry.mint(node, ROOT_CONTEXT);
    }
  });
  return registry;
}
