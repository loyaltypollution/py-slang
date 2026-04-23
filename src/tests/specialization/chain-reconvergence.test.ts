import { StmtNS } from "../../ast-types";
import {
  ROOT_CONTEXT,
  type AssumptionChain,
} from "../../specialization/lattice/chain";
import {
  at,
  extend,
  without,
} from "../../specialization/lattice/algebra";
import { paramKey } from "../../specialization/framework/key-spaces";
import { runtimeParamChannel } from "../../specialization/assumption/runtime-analyses";
import { paramTypeNarrowing } from "../../specialization/assumption/param-handles";
import { setupAndDrain } from "./harness/compile-pipelines";

describe("chain reconvergence across widen → re-observe (Python-driven)", () => {
  test("hot shape → deopt → same shape: reborn chain === original", () => {
    // Two-param function. `paramTypeNarrowing` is the only param narrowing
    // wired into `DEFAULT_NARROWINGS` (paramConstNarrowing was disabled —
    // see the comment in const-analysis/analysis.ts about recursive-call
    // thrash), so each param contributes exactly one link per shape.
    const { ast, worklist } = setupAndDrain(
      "def f(x, y):\n    return x + y\n",
    );
    const fd = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.topology.unitOfFunctionId(fd.id)!;
    const kx = paramKey(fd.id, 0);
    const ky = paramKey(fd.id, 1);

    // Each publish takes the "active context at observe-time" — thread the
    // first publish's return value (the extended chain) into the second so
    // the two publishes stack instead of each starting from ROOT.
    const afterKx = worklist.publish(
      runtimeParamChannel, kx, { kind: "number", value: 3 }, ROOT_CONTEXT,
    );
    worklist.drain();
    worklist.publish(
      runtimeParamChannel, ky, { kind: "number", value: 4 }, afterKx,
    );
    worklist.drain();

    const hotChain = worklist.futureDispatchChainFor(unit);
    expect(at(hotChain, paramTypeNarrowing, kx)).not.toBeUndefined();
    expect(at(hotChain, paramTypeNarrowing, ky)).not.toBeUndefined();

    // Simulate a deopt localized to y — reduces to `excludeAssumption` at
    // y's link, which is what `widenGuard` does once the lineage pins the
    // violation to a single assumption.
    const widened = without(hotChain, paramTypeNarrowing, ky);
    expect(widened).not.toBe(hotChain);
    expect(at(widened, paramTypeNarrowing, ky)).toBeUndefined();
    // x-side link survives.
    expect(at(widened, paramTypeNarrowing, kx)).not.toBeUndefined();

    // Re-observe y with the same shape. The interner must reconverge.
    const ty = paramTypeNarrowing.lift({ kind: "number", value: 4 })!;
    const reborn = extend(widened, paramTypeNarrowing, ky, ty);
    expect(reborn).toBe(hotChain);
  });

  test("extend is order-independent: reversed arrival order canonicalizes", () => {
    // `fn.id` is a process-global monotonic counter (ast-types.ts), so two
    // parses of the same source produce disjoint key spaces; cross-parse
    // chain identity is not a framework contract. The real invariant is
    // intra-interner: `extend` canonicalizes links so that applying the
    // same (narrowing, key, value) triples in opposite orders reaches the
    // same AssumptionChain node.
    const { ast, worklist } = setupAndDrain(
      "def f(x, y):\n    return x * y\n",
    );
    const fd = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.topology.unitOfFunctionId(fd.id)!;

    worklist.publish(
      runtimeParamChannel, paramKey(fd.id, 0),
      { kind: "number", value: 7 }, ROOT_CONTEXT,
    );
    worklist.publish(
      runtimeParamChannel, paramKey(fd.id, 1),
      { kind: "number", value: 11 }, ROOT_CONTEXT,
    );
    worklist.drain();

    const chain = worklist.futureDispatchChainFor(unit);

    // Walk chain child-first, then rebuild from ROOT in that (reversed)
    // arrival order. Interner canonicalization makes the result ===.
    const links: Array<{ n: any; k: any; v: any }> = [];
    for (let cur: AssumptionChain | undefined = chain; cur !== undefined; cur = cur.parent) {
      if (cur.assumption !== undefined) {
        links.push({
          n: cur.assumption.narrowing,
          k: cur.assumption.key,
          v: cur.assumption.value,
        });
      }
    }
    let rebuilt: AssumptionChain = ROOT_CONTEXT;
    for (const l of links) {
      rebuilt = extend(rebuilt, l.n, l.k, l.v);
    }
    expect(rebuilt).toBe(chain);
  });
});
