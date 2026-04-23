// Drain barrier invariants.
//
// Contracts verified:
//   1. Idempotent drain — a second drain with no new observations fires
//      zero transforms and reports zero rebuilds. Pins the convergence
//      condition: if `!fired && rebuilt.length === 0`, break.
//   2. Reentrancy guard — `publish` / `bump` invoked during `sweepTransforms`
//      throw. Converts the social invariant "observations fire outside drain"
//      into a structural one.

import { StmtNS } from "../../../ast-types";
import { parse } from "../../../parser/parser-adapter";
import { analyzeWithEnvironments } from "../../../resolver";
import math from "../../../stdlib/math";
import memo from "../../../stdlib/memo";
import misc from "../../../stdlib/misc";
import type { TransformRule } from "../../../specialization/framework/analysis";
import type {
  AssumptionChain,
} from "../../../specialization/framework/assumption-chain";
import { ROOT_CONTEXT } from "../../../specialization/framework/assumption-chain";
import type { Unit } from "../../../specialization/framework/function-unit";
import { paramKey } from "../../../specialization/framework/key-spaces";
import {
  runtimeCallCounter,
  runtimeParamChannel,
} from "../../../specialization/framework/runtime-analyses";
import type { ProgramTopology } from "../../../specialization/framework/topology";
import { buildTestWorklist } from "../../utils";

function build(code: string) {
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { environments } = analyzeWithEnvironments(ast, script, 4, [misc, math, memo]);
  const worklist = buildTestWorklist(ast, environments);
  worklist.drain();
  return { ast, worklist };
}

describe("Worklist.drain idempotency", () => {
  test("second drain with no new observations returns empty changed set", () => {
    const { worklist } = build(`
def hot(x):
    if x <= 0:
        return -1
    return x
`);
    // First drain already ran inside build().
    const changed = worklist.drain();
    expect(changed.size).toBe(0);
  });

  test("drain is idempotent after an observation round-trip", () => {
    const { ast, worklist } = build(`
def hot(x):
    if x <= 0:
        return -1
    return x
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;
    worklist.publish(
      runtimeParamChannel,
      paramKey(fn.id, 0),
      { kind: "number", value: 8 },
      ROOT_CONTEXT,
    );
    worklist.drain();

    // No new observations between the two drains → second drain must be a no-op.
    const second = worklist.drain();
    expect(second.size).toBe(0);
  });
});

describe("Worklist.sweepTransforms reentrancy guard", () => {
  test("publish during a transform sweep throws", () => {
    const { ast, worklist } = build(`
def f(x):
    return x
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;

    let sawThrow = false;
    const rule: TransformRule = {
      sweep(_unit: Unit, _chain: AssumptionChain, _topology: ProgramTopology): boolean {
        try {
          worklist.publish(
            runtimeParamChannel,
            paramKey(fn.id, 0),
            { kind: "number", value: 1 },
            ROOT_CONTEXT,
          );
        } catch (e) {
          sawThrow = true;
          expect((e as Error).message).toMatch(/transform sweep/);
        }
        return false;
      },
    };
    const unit = worklist.topology.unitOfFunctionId(fn.id)!;
    worklist.registerTransform(rule);
    worklist.onTransformChannelPublished(rule, runtimeParamChannel, () => [unit]);

    // Fire an observation that dirties the rule, then drain — the rule runs
    // inside sweepTransforms and its inner publish must throw.
    worklist.publish(
      runtimeParamChannel,
      paramKey(fn.id, 0),
      { kind: "number", value: 2 },
      ROOT_CONTEXT,
    );
    worklist.drain();
    expect(sawThrow).toBe(true);
  });

  test("bump during a transform sweep throws", () => {
    const { ast, worklist } = build(`
def g(y):
    return y
`);
    const fn = ast.statements[0] as StmtNS.FunctionDef;

    let sawThrow = false;
    const rule: TransformRule = {
      sweep(_unit: Unit, _chain: AssumptionChain, _topology: ProgramTopology): boolean {
        try {
          worklist.bump(runtimeCallCounter, fn.id);
        } catch (e) {
          sawThrow = true;
          expect((e as Error).message).toMatch(/transform sweep/);
        }
        return false;
      },
    };
    const unit = worklist.topology.unitOfFunctionId(fn.id)!;
    worklist.registerTransform(rule);
    worklist.onTransformChannelPublished(rule, runtimeParamChannel, () => [unit]);

    worklist.publish(
      runtimeParamChannel,
      paramKey(fn.id, 0),
      { kind: "number", value: 3 },
      ROOT_CONTEXT,
    );
    worklist.drain();
    expect(sawThrow).toBe(true);
  });
});
