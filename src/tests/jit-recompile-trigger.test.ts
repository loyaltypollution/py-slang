/**
 * PR-5 jitPass + saturating callCountPass: structural fix for the
 * "callCount++ triggers full recompile" pathology.
 *
 * The test mocks the JIT side-effect (compile + patch) and feeds raw
 * call counts through `Worklist.observe(runtimeCallPass, …)`. We
 * verify:
 *   1. callCountPass saturates at MEMOIZATION_THRESHOLD + 1; subsequent
 *      writes of the same raw count produce no fact-store onChange.
 *   2. A registered jitPass-style consumer is woken on every strict
 *      bucket increase but suppressed on equal-bucket writes — so its
 *      transfer runs at most `THRESHOLD + 1` times across the call
 *      stream, not once per CALL.
 */

import { parse } from "../parser/parser-adapter";
import { analyzeWithEnvironments } from "../resolver";
import { buildTestWorklist } from "./utils";
import {
  MEMOIZATION_THRESHOLD,
  callCountPass,
  runtimeCallPass,
} from "../specialization";
import type { Pass, PassCtx } from "../specialization/framework/pass";
import type { FunctionUnit } from "../specialization/framework/function-unit";
import { StmtNS } from "../ast-types";

function setup() {
  const code = `
def f():
    return 1
f()
`;
  const script = code + "\n";
  const ast = parse(script) as StmtNS.FileInput;
  const { environments } = analyzeWithEnvironments(ast, script, 4);
  const worklist = buildTestWorklist(ast, environments);
  worklist.converge();
  const fDef = ast.statements[0] as StmtNS.FunctionDef;
  const unit = worklist.units.get(fDef)!;
  return { worklist, unit, fDef };
}

describe("PR-5 jitPass + callCountPass saturation", () => {
  test("callCountPass saturates and suppresses consumer wakeups past SAT", () => {
    const { worklist, fDef } = setup();
    const N_CALLS = MEMOIZATION_THRESHOLD * 5; // well past saturation

    let transferRuns = 0;
    const observer: Pass<number, number> = {
      id: Symbol("observer"),
      debugName: "observer",
      lattice: {
        bottom: 0,
        equals: (a, b) => a === b,
        join: (a, b) => Math.max(a, b),
      },
      reads: [callCountPass],
      tier: "transform",
      transfer(ctx: PassCtx, key: number): number | undefined {
        transferRuns++;
        const v = ctx.read(callCountPass, key);
        return v ?? 0;
      },
      affectedKeys(_ctx, triggerPass, triggerKey) {
        if (triggerPass === (callCountPass as Pass<any, any>)) {
          return [triggerKey as number];
        }
        return [];
      },
    };
    worklist.register(observer);

    for (let i = 1; i <= N_CALLS; i++) {
      worklist.observe(runtimeCallPass, fDef.id, i);
    }

    // Saturation bound: bucket transitions are 1, 2, …, MEMOIZATION_THRESHOLD,
    // SAT — that's MEMOIZATION_THRESHOLD + 1 distinct values. Every other
    // write of the same raw count past SAT collapses under
    // `lattice.equals` and wakes nothing.
    expect(transferRuns).toBeLessThanOrEqual(MEMOIZATION_THRESHOLD + 1);
    expect(transferRuns).toBeGreaterThan(0);
  });

  test("jit-style transfer fires patchFunction exactly once at threshold (idempotence rule)", () => {
    const { worklist, unit, fDef } = setup();

    let patchCalls = 0;
    let nextDigest = 0;
    // Side-effect-bearing pass: each call to `patchFunction` is gated by
    // the lattice-equals check on its produced digest. We model the
    // compiler as deterministic-after-saturation: digest stays at 1 once
    // callCountPass has saturated.
    const jitPass: Pass<FunctionUnit, number> = {
      id: Symbol("test-jitPass"),
      debugName: "test-jitPass",
      lattice: {
        bottom: 0,
        equals: (a, b) => a === b,
        join: (a, b) => Math.max(a, b),
      },
      reads: [callCountPass],
      tier: "transform",
      affectedKeys(_ctx, _triggerPass, _triggerKey) {
        return [unit];
      },
      transfer(ctx: PassCtx, _u: FunctionUnit): number | undefined {
        const c = ctx.read(callCountPass, fDef.id) ?? 0;
        // Only "compile" once the bucket reaches saturation — the
        // memoizationRule contract.
        if (c <= MEMOIZATION_THRESHOLD) return undefined;
        const digest = 1; // stable once compiled
        const prev = ctx.read(jitPass, _u);
        if (prev === digest) return undefined;
        patchCalls++;
        nextDigest = digest;
        return digest;
      },
    };
    worklist.register(jitPass);
    worklist.enqueue(jitPass, unit);
    worklist.drainPasses();
    expect(patchCalls).toBe(0); // nothing observed yet

    for (let i = 1; i <= MEMOIZATION_THRESHOLD * 3; i++) {
      worklist.observe(runtimeCallPass, fDef.id, i);
    }

    expect(patchCalls).toBe(1);
    expect(nextDigest).toBe(1);
  });
});
