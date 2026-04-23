import { ExprNS, StmtNS } from "../../ast-types";
import { traverseAST } from "../../validator/traverse";
import { AssumptionChain, ROOT_CONTEXT, isRoot } from "./assumption-chain";

export type FunctionScopeNode =
  | StmtNS.FileInput
  | StmtNS.FunctionDef
  | ExprNS.Lambda
  | ExprNS.MultiLambda;

/** Observes structural events on the registry. The owning Worklist (if any)
 *  attaches itself here so that mint/retire wake downstream analyses for the
 *  affected units. Registry does not know about the Worklist lifecycle API;
 *  it only dispatches "what happened to whom". */
export interface FunctionRegistryListener {
  onMint(node: FunctionScopeNode, slot: number): void;
  onRetire(functionId: number, node: FunctionScopeNode): void;
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
 *
 * ## ROOT-only invariant
 *
 * `mint`/`retire` require `chain === ROOT_CONTEXT` and assert it. The registry
 * is global — slots and functionIds have no chain dimension — so a speculative
 * structural rewrite under a non-ROOT chain would publish a new function that
 * every sibling chain can also observe, violating the isolation that
 * `forkBody` provides for body mutations.
 *
 * Example of what this rules out: a transform that, under the assumption
 * `x: int`, inlines a helper `f` as a freshly-minted specialized function
 * `f_int`. If the chain assuming `x: int` is later retired (assumption
 * invalidated), `f_int` would remain in the registry and compiler output,
 * despite no chain justifying its existence. Worse, a sibling chain assuming
 * `x: str` would see `f_int` too.
 *
 * If you are writing such a transform and hitting this assert: the fix is not
 * to weaken it. The fix is to make the registry chain-scoped (mirror the
 * per-(Unit, AssumptionChain) body-fork model on `AssumptionChain`), so mint/retire
 * are scoped to the chain that created them and cascade on chain retirement.
 * That is a real contract change — justify it against a concrete consumer
 * rather than pre-emptively.
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
  mint(node: FunctionScopeNode, chain: AssumptionChain): number {
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

  /** Remove `functionId` from the registry. Slot number is not reused.
   *  `chain` must be `ROOT_CONTEXT`; see the class-level "ROOT-only invariant"
   *  section. */
  retire(functionId: number, chain: AssumptionChain): void {
    if (!isRoot(chain)) {
      throw new Error(
        `FunctionRegistry.retire: structural rewrites are ROOT-only ` +
          `(chain depth=${chain.depth}). See class doc "ROOT-only invariant".`,
      );
    }
    const entry = this.byFunctionId.get(functionId);
    if (!entry) {
      throw new Error(`FunctionRegistry: functionId=${functionId} not registered`);
    }
    this.byFunctionId.delete(functionId);
    this.nodeToFunctionId.delete(entry.node);
    this.listener?.onRetire(functionId, entry.node);
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
   *  slot order without an explicit sort — `retire` only removes entries,
   *  it does not reorder survivors. */
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
