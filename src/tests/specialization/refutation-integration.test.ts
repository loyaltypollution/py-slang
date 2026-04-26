// Integration test for the refutation filter through the worklist's
// observation path.
//
// Regression for the singleton-vs-carrier bug: retireChain previously
// added the full carrier chain (all parent-path bindings) to the
// refutation filter, so sibling chains carrying the same refuted
// binding under a different prefix escaped `isRefuted`. The fix
// retires the minimal singleton of the refuted binding.

import { StmtNS } from "../../ast-types";
import { ROOT_CONTEXT } from "../../specialization/assumption/chain";
import { bindings, extend } from "../../specialization/assumption/algebra";
import { paramKey } from "../../specialization/narrowing-policy/param-key";
import { runtimeParamSource } from "../../specialization/observation/runtime-analyses";
import { setupAndDrain } from "./harness/compile-pipelines";

describe("refutation filter: worklist integration", () => {
  test("sibling-prefix chains carrying the refuted binding are retired", () => {
    // def f(x, y): ...
    // Run A: observe x=true, y=true → chain {p0:true, p1:true}.
    // Run B: under that chain, observe y=false → refutes p1:true.
    // Sibling chain {p1:true} alone (built by hand, no p0 prefix) must
    // also report as retired — the refuted binding is absolute, not
    // conditional on any co-observed prefix.
    const { ast, worklist } = setupAndDrain(`
def f(x, y):
    return x
`);
    const fd = ast.statements[0] as StmtNS.FunctionDef;
    const unit = worklist.locate.functionById(fd.id)!;

    worklist.observe(
      runtimeParamSource,
      paramKey(fd.id, 0),
      { kind: "bool", value: true },
      ROOT_CONTEXT,
    );
    worklist.drain();
    const afterP0 = worklist.futureDispatchChainFor(unit);
    worklist.observe(
      runtimeParamSource,
      paramKey(fd.id, 1),
      { kind: "bool", value: true },
      afterP0,
    );
    worklist.drain();
    const twoParamChain = worklist.futureDispatchChainFor(unit);

    // Capture the lifted binding for p1 before the worklist mutates the
    // chain during retirement. We rebuild a sibling chain by hand using
    // exactly the same (narrowing, key, value) triple.
    const p1Key = paramKey(fd.id, 1);
    const p1Binding = [...bindings(twoParamChain)].find(a => a.key === p1Key);
    expect(p1Binding).not.toBeUndefined();

    // Refute p1's value. Worklist.retireChain adds the minimal singleton
    // {p1:true} to the refutation filter (not the 2-binding carrier).
    worklist.observe(
      runtimeParamSource,
      paramKey(fd.id, 1),
      { kind: "bool", value: false },
      twoParamChain,
    );
    worklist.drain();

    // Sibling chain: only the refuted binding, no p0 prefix.
    const sibling = extend(ROOT_CONTEXT, p1Binding!.narrowing, p1Binding!.key, p1Binding!.value);

    // The crux: pre-fix this returned false (carrier-generator failed to
    // match because sibling doesn't contain p0). Post-fix the singleton
    // generator ⊑ sibling, so isRefuted returns true.
    expect(worklist.isRefuted(sibling)).toBe(true);

    // Sanity: the original refuted chain is also retired (both before
    // and after the fix).
    expect(worklist.isRefuted(twoParamChain)).toBe(true);
  });
});
