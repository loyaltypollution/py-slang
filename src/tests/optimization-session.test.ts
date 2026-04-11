/**
 * Tests for OptimizationSession: state transitions, subscriber notifications,
 * and differential correctness vs runCFGOptimization.
 */

import { StmtNS } from "../ast-types";
import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import {
  OptimizationSession,
  OptimizationSubscriber,
  runCFGOptimization,
  HintStore,
  buildSlotTable,
  TypeAnalysisModule,
  ConstAnalysisModule,
  ConstantFoldingRule,
  DeadBranchEliminationRule,
} from "../specialization";

const analyses = () => [new TypeAnalysisModule(), new ConstAnalysisModule()];
const transforms = () => [new DeadBranchEliminationRule(), new ConstantFoldingRule()];

function parseAndResolve(code: string) {
  const script = code + "\n";
  const ast = parse(script);
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const env = environments.get(ast)!;
  const slotLookup = buildSlotTable(env, []);
  return { ast, stmts: ast.statements, slotLookup };
}

function makeSession(code: string): { session: OptimizationSession; stmts: StmtNS.Stmt[] } {
  const { stmts, slotLookup } = parseAndResolve(code);
  const hints = new HintStore();
  const session = new OptimizationSession(stmts, analyses(), transforms(), hints, slotLookup);
  return { session, stmts };
}

/**
 * Serialize statement structure for comparison, excluding node IDs and tokens
 * (which differ between two separate parses of the same code).
 */
function serializeStmts(stmts: StmtNS.Stmt[]): string {
  return JSON.stringify(stmts, (key, val) => {
    if (key === "id" || key === "startToken" || key === "endToken") return undefined;
    return val;
  });
}

// ── Differential tests ─────────────────────────────────────────────────────

describe("OptimizationSession: differential vs runCFGOptimization", () => {
  const programs = [
    { name: "dead branch (True)", code: "if True:\n  x = 1\nelse:\n  x = 2" },
    { name: "dead branch (False)", code: "if False:\n  x = 1\nelse:\n  x = 2" },
    { name: "constant folding", code: "x = 1 + 2" },
    { name: "compound", code: "if True:\n  x = 1 + 2\nelse:\n  x = 99" },
    { name: "no transforms", code: "x = 1\ny = 2" },
  ];

  test.each(programs)("$name: converge() matches runCFGOptimization", ({ code }) => {
    // Old path
    const old = parseAndResolve(code);
    const oldHints = new HintStore();
    runCFGOptimization(old.stmts, analyses(), transforms(), oldHints, old.slotLookup);

    // New path
    const neu = parseAndResolve(code);
    const neuHints = new HintStore();
    const session = new OptimizationSession(
      neu.stmts, analyses(), transforms(), neuHints, neu.slotLookup,
    );
    session.converge();

    // Same AST structure after transforms
    expect(serializeStmts(neu.stmts)).toBe(serializeStmts(old.stmts));
  });
});

// ── State transitions ──────────────────────────────────────────────────────

describe("OptimizationSession: state transitions", () => {
  test("fresh session: state is ready, round is 0", () => {
    const { session } = makeSession("x = 1");
    expect(session.state).toBe("ready");
    expect(session.round).toBe(0);
  });

  test("after step(): state is analyzed, round is 1", () => {
    const { session } = makeSession("x = 1");
    session.step();
    expect(session.state).toBe("analyzed");
    expect(session.round).toBe(1);
  });

  test("after applyTransforms(): state is ready", () => {
    const { session } = makeSession("x = 1");
    session.step();
    session.applyTransforms();
    expect(session.state).toBe("ready");
  });

  test("second step() increments round to 2", () => {
    const { session } = makeSession("x = 1");
    session.step();
    session.applyTransforms();
    session.step();
    expect(session.round).toBe(2);
  });
});

// ── Edge cases ─────────────────────────────────────────────────────────────

describe("OptimizationSession: edge cases", () => {
  test("step() in analyzed state: re-analyzes without error", () => {
    const { session } = makeSession("x = 1");
    session.step();
    expect(session.state).toBe("analyzed");
    session.step(); // should not throw
    expect(session.state).toBe("analyzed");
    expect(session.round).toBe(2);
  });

  test("applyTransforms() in ready state: returns false (no-op)", () => {
    const { session } = makeSession("x = 1");
    expect(session.state).toBe("ready");
    expect(session.applyTransforms()).toBe(false);
  });
});

// ── Subscriber notifications ───────────────────────────────────────────────

describe("OptimizationSession: subscribers", () => {
  test("onRoundComplete called after step()", () => {
    const { session } = makeSession("x = 1");
    const calls: string[] = [];
    const sub: OptimizationSubscriber = {
      name: "test",
      onRoundComplete: () => calls.push("round"),
    };
    session.addSubscriber(sub);
    session.step();
    expect(calls).toEqual(["round"]);
  });

  test("onTransformsApplied called after applyTransforms()", () => {
    const { session } = makeSession("x = 1");
    const calls: string[] = [];
    const sub: OptimizationSubscriber = {
      name: "test",
      onTransformsApplied: () => calls.push("transform"),
    };
    session.addSubscriber(sub);
    session.step();
    session.applyTransforms();
    expect(calls).toEqual(["transform"]);
  });

  test("converge notifies subscriber for each round", () => {
    const { session } = makeSession("if True:\n  x = 1 + 2\nelse:\n  x = 99");
    const rounds: number[] = [];
    const sub: OptimizationSubscriber = {
      name: "counter",
      onRoundComplete: (s) => rounds.push(s.round),
    };
    session.addSubscriber(sub);
    session.converge();
    // At least 1 round, and rounds are strictly increasing
    expect(rounds.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < rounds.length; i++) {
      expect(rounds[i]).toBeGreaterThan(rounds[i - 1]);
    }
  });

  test("removeSubscriber stops notifications", () => {
    const { session } = makeSession("x = 1");
    const calls: string[] = [];
    const sub: OptimizationSubscriber = {
      name: "test",
      onRoundComplete: () => calls.push("round"),
    };
    session.addSubscriber(sub);
    session.step();
    session.removeSubscriber(sub);
    session.applyTransforms();
    session.step();
    expect(calls).toEqual(["round"]); // only the first step
  });
});

// ── Converge behavior ──────────────────────────────────────────────────────

describe("OptimizationSession: converge", () => {
  test("no-op code: converge runs exactly 1 round", () => {
    const { session } = makeSession("x = 1\ny = 2");
    session.converge();
    expect(session.round).toBe(1);
  });
});
