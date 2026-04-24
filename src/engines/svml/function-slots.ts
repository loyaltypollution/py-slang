import { ExprNS, StmtNS } from "../../ast-types";
import { traverseAST } from "../../validator/traverse";

export type FunctionScopeNode =
  | StmtNS.FileInput
  | StmtNS.FunctionDef
  | ExprNS.Lambda
  | ExprNS.MultiLambda;

/**
 * SVML-local dense slot allocation for the bytecode function table.
 *
 * Slot 0 is the FileInput; subsequent slots are assigned monotonically in
 * pre-order DFS over `FunctionDef`/`Lambda`/`MultiLambda` at construction.
 * Slots are never reused.
 *
 * Functions that appear AFTER construction (e.g. minted by a structural
 * transform) get a fresh slot the first time `slotOfNode` is queried. Callers
 * that need a non-allocating existence check use `slotOf(functionId)`.
 */
export class SvmlSlotTable {
  private readonly byFunctionId = new Map<number, number>();
  private next = 0;

  constructor(program: StmtNS.FileInput) {
    this.byFunctionId.set(program.id, this.next++);
    traverseAST(program, node => {
      if (
        node instanceof StmtNS.FunctionDef ||
        node instanceof ExprNS.Lambda ||
        node instanceof ExprNS.MultiLambda
      ) {
        this.byFunctionId.set(node.id, this.next++);
      }
    });
  }

  /** Slot for `node`. Allocates if the node hasn't been seen — use `slotOf`
   *  when that allocation would be incorrect. */
  slotOfNode(node: FunctionScopeNode): number {
    const existing = this.byFunctionId.get(node.id);
    if (existing !== undefined) return existing;
    const slot = this.next++;
    this.byFunctionId.set(node.id, slot);
    return slot;
  }

  /** Existing slot, or `undefined` if unknown. Non-allocating. */
  slotOf(functionId: number): number | undefined {
    return this.byFunctionId.get(functionId);
  }

  get size(): number {
    return this.byFunctionId.size;
  }
}
