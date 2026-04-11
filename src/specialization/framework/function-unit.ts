import { StmtNS } from "../../ast-types";
import type { FunctionEnvironments } from "../../resolver";
import { HintStore } from "./hint";
import type { SlotTable } from "./slot-table";
import { buildSlotTable } from "./slot-table";

/**
 * AST node that introduces a function scope.
 *
 * Lambda and MultiLambda are excluded: the DFA skips their bodies
 * (single-expression / not yet analyzed). They can be added when
 * expression-level scope collection is implemented.
 */
export type ScopeNode =
  | StmtNS.FileInput
  | StmtNS.FunctionDef;

/**
 * FunctionUnit: the unit of optimization grouping.
 *
 * One per function scope. Owns its body, hints, and slot assignments.
 * Consumers pull updates via the version stamp.
 */
export interface FunctionUnit {
  readonly scopeNode: ScopeNode;
  readonly body: StmtNS.Stmt[];
  readonly hints: HintStore;
  readonly slotTable: SlotTable;
  /** Monotonic version stamp. 0 = not yet analyzed. Bumped after stabilize. */
  version: number;
  readonly children: FunctionUnit[];
}

/**
 * Build the FunctionUnit tree from an AST and its resolved environments.
 *
 * Walks scope boundaries (FileInput → FunctionDef → nested defs).
 * Lambda is skipped (DFA does not analyze single-expression lambda bodies).
 */
export function buildFunctionUnits(
  ast: StmtNS.FileInput,
  functionEnvironments: FunctionEnvironments,
): FunctionUnit {
  return buildUnit(ast, functionEnvironments);
}

function buildUnit(
  scopeNode: ScopeNode,
  functionEnvironments: FunctionEnvironments,
): FunctionUnit {
  const env = functionEnvironments.get(scopeNode);
  if (!env) {
    throw new Error(`Environment not found for scope node ${scopeNode.kind}`);
  }

  const body = getBody(scopeNode);
  const paramNames = getParamNames(scopeNode);
  const slotTable = buildSlotTable(env, paramNames);

  const children: FunctionUnit[] = [];
  for (const childDef of collectNestedScopes(body)) {
    children.push(buildUnit(childDef, functionEnvironments));
  }

  return { scopeNode, body, hints: new HintStore(), slotTable, version: 0, children };
}

function getBody(node: ScopeNode): StmtNS.Stmt[] {
  if (node instanceof StmtNS.FileInput) return node.statements;
  return node.body;
}

function getParamNames(node: ScopeNode): string[] {
  if (node instanceof StmtNS.FileInput) return [];
  return node.parameters.map(p => p.lexeme);
}

/**
 * Shallow-walk a statement list to find FunctionDef and MultiLambda nodes.
 * Recurses into control flow blocks (if/while/for) but stops at function
 * boundaries — nested functions are children of THEIR parent unit.
 */
function collectNestedScopes(body: StmtNS.Stmt[]): ScopeNode[] {
  const scopes: ScopeNode[] = [];
  const walker = new ScopeCollector(scopes);
  for (const stmt of body) stmt.accept(walker);
  return scopes;
}

class ScopeCollector implements StmtNS.Visitor<void> {
  constructor(private readonly scopes: ScopeNode[]) {}

  visitFunctionDefStmt(stmt: StmtNS.FunctionDef): void {
    this.scopes.push(stmt);
    // Do NOT recurse into the function body — it's the child unit's territory.
  }

  visitIfStmt(stmt: StmtNS.If): void {
    for (const s of stmt.body) s.accept(this);
    if (stmt.elseBlock) {
      for (const s of stmt.elseBlock) s.accept(this);
    }
  }

  visitWhileStmt(stmt: StmtNS.While): void {
    for (const s of stmt.body) s.accept(this);
  }

  visitForStmt(stmt: StmtNS.For): void {
    for (const s of stmt.body) s.accept(this);
  }

  visitFileInputStmt(stmt: StmtNS.FileInput): void {
    for (const s of stmt.statements) s.accept(this);
  }

  // Statements that cannot contain nested function definitions
  visitAssignStmt(_stmt: StmtNS.Assign): void {}
  visitAnnAssignStmt(_stmt: StmtNS.AnnAssign): void {}
  visitReturnStmt(_stmt: StmtNS.Return): void {}
  visitSimpleExprStmt(_stmt: StmtNS.SimpleExpr): void {}
  visitAssertStmt(_stmt: StmtNS.Assert): void {}
  visitPassStmt(_stmt: StmtNS.Pass): void {}
  visitBreakStmt(_stmt: StmtNS.Break): void {}
  visitContinueStmt(_stmt: StmtNS.Continue): void {}
  visitGlobalStmt(_stmt: StmtNS.Global): void {}
  visitNonLocalStmt(_stmt: StmtNS.NonLocal): void {}
  visitFromImportStmt(_stmt: StmtNS.FromImport): void {}
}

/**
 * Flatten the FunctionUnit tree into a Map keyed by scopeNode identity.
 * O(1) lookup by scope node for consumers (e.g., compiler).
 */
export function flattenUnits(root: FunctionUnit): Map<ScopeNode, FunctionUnit> {
  const map = new Map<ScopeNode, FunctionUnit>();
  function walk(unit: FunctionUnit): void {
    map.set(unit.scopeNode, unit);
    for (const child of unit.children) walk(child);
  }
  walk(root);
  return map;
}
