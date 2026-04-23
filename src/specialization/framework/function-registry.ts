import { ExprNS, StmtNS } from "../../ast-types";
import { traverseAST } from "../../validator/traverse";
import { Speculation, ROOT_CONTEXT, isRoot } from "./assumption-chain";

export type FunctionScopeNode =
  | StmtNS.FileInput
  | StmtNS.FunctionDef
  | ExprNS.Lambda
  | ExprNS.MultiLambda;

/** Observes structural events on the registry. The owning Worklist (if any)
 *  attaches itself here so that mint wakes downstream analyses for the
 *  affected unit. Registry does not know about the Worklist lifecycle API;
 *  it only dispatches "what happened to whom". */
export interface FunctionRegistryListener {
  onMint(node: FunctionScopeNode, slot: number): void;
}

/**
 * Canonical owner of function identity and bytecode slot layout.
 *
 * Identity is `node.id` (stable, readonly, stamped at AST construction).
 * Slots are assigned monotonically at `mint` time and never reused within a
 * registry instance. Callers look up by either the node or the node.id; both
 * resolve to the same slot.
 *
 * ## mint contract
 *
 * Structural transforms that add a FunctionDef/Lambda/MultiLambda MUST call
 * `mint`. Skipping diverges the registry from the worklist/compiler silently
 * and miscompiles. The throw in this class converts the silent-miscompile
 * failure mode into a loud "not registered" at the first slot lookup.
 *
 * The registry's `listener` hook fires onMint for the newly-minted unit.
 * Rebuilding the enclosing unit whose body structurally changed is handled
 * by the worklist's transform sweep: a `TransformRule.sweep` that mutates
 * the enclosing unit returns `true`, and the worklist schedules the rebuild
 * automatically.
 *
 * No retire path exists. Slots are append-only within a registry instance;
 * function retirement would be chain-scoped (a structural rewrite under a
 * non-ROOT chain must not invalidate siblings), and no production transform
 * retires today. If such a transform arrives, the registry has to be made
 * chain-scoped (mirror the per-(Unit, Speculation) body-fork model), since
 * slots and functionIds currently have no chain dimension.
 *
 * ## ROOT-only invariant
 *
 * `mint` requires `chain === ROOT_CONTEXT` and asserts it. The registry is
 * global — slots and functionIds have no chain dimension — so a speculative
 * structural rewrite under a non-ROOT chain would publish a new function
 * that every sibling chain can also observe, violating the isolation that
 * `forkBody` provides for body mutations.
 */
export class FunctionRegistry {
  private nextSlot = 0;
  private readonly byFunctionId = new Map<number, { node: FunctionScopeNode; slot: number }>();
  private readonly nodeToFunctionId = new WeakMap<FunctionScopeNode, number>();
  private listener: FunctionRegistryListener | undefined;

  /** Attach the single structural-event listener (the owning Worklist).
   *  Replaces any prior listener. Analysis `undefined` to detach. */
  setListener(listener: FunctionRegistryListener | undefined): void {
    this.listener = listener;
  }

  /** Allocate and record a slot for `node`. Throws if already registered.
   *  `chain` must be `ROOT_CONTEXT`; see the class-level "ROOT-only invariant"
   *  section for the rationale and the fix path if you need non-ROOT minting. */
  mint(node: FunctionScopeNode, chain: Speculation): number {
    if (!isRoot(chain)) {
      throw new Error(
        `FunctionRegistry.mint: structural rewrites are ROOT-only ` +
          `(chain depth=${chain.depth}). See class doc "ROOT-only invariant".`,
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

  nodeOf(functionId: number): FunctionScopeNode {
    const entry = this.byFunctionId.get(functionId);
    if (!entry) {
      throw new Error(`FunctionRegistry: functionId=${functionId} not registered`);
    }
    return entry.node;
  }

  has(functionId: number): boolean {
    return this.byFunctionId.has(functionId);
  }

  hasNode(node: FunctionScopeNode): boolean {
    return this.nodeToFunctionId.has(node);
  }

  /** Snapshot of `functionId → slot` for tests and debugging. */
  snapshot(): ReadonlyMap<number, number> {
    const out = new Map<number, number>();
    for (const [functionId, entry] of this.byFunctionId) out.set(functionId, entry.slot);
    return out;
  }

  /** Iterate entries in mint order (slot-ascending). Map iteration is
   *  insertion-order, and `mint` assigns `nextSlot++`, so this matches
   *  slot order without an explicit sort. */
  *entries(): IterableIterator<{ functionId: number; node: FunctionScopeNode; slot: number }> {
    for (const [functionId, { node, slot }] of this.byFunctionId) yield { functionId, node, slot };
  }

  get size(): number {
    return this.byFunctionId.size;
  }
}

/**
 * Build a fresh registry by pre-order DFS over `program`: FileInput first,
 * then nested FunctionDef/Lambda/MultiLambda in traversal order. Slot order
 * is byte-identical to the legacy `computeFunctionIndices` analysis, so bytecode
 * layout is preserved during the migration.
 */
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
