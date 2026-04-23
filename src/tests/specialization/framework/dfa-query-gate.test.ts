// Type-gate evidence for P3: the speculative readers on DfaQuery MUST NOT
// appear on the widened StaticDfaQuery type, so a TransformRule that
// accepts only StaticDfaQuery cannot reach them. The `@ts-expect-error`
// directives double as the compile-time assertion — if this file ever
// typechecks without the errors, the split has regressed.

import { parse } from "../../../parser/parser-adapter";
import { Resolver } from "../../../resolver";
import {
  makeDfaQuery,
  type DfaQuery,
  type StaticDfaQuery,
} from "../../../specialization";
import { createDefaultWorklist } from "../../../specialization/defaults";

describe("DfaQuery / StaticDfaQuery split", () => {
  test("StaticDfaQuery exposes only ∅-context reads; speculative readers are unreachable", () => {
    const ast = parse("x = 1\n");
    const resolver = new Resolver("x = 1\n", ast);
    resolver.resolve(ast);
    const wl = createDefaultWorklist(ast, resolver.functionEnvironments);
    const full: DfaQuery = makeDfaQuery(wl.topology);
    // Structural widening — a DfaQuery IS a StaticDfaQuery.
    const restricted: StaticDfaQuery = full;

    // Sound readers are present on both sides.
    expect(typeof restricted.typeOf).toBe("function");
    expect(typeof restricted.constOf).toBe("function");
    expect(typeof restricted.isPureScope).toBe("function");

    // Speculative readers are absent from StaticDfaQuery — the following
    // lines must fail the typechecker. If any of them stop failing, the
    // boundary that makes P3 unrepresentable has regressed.

    // @ts-expect-error — speculativeTypeOf is not on StaticDfaQuery
    restricted.speculativeTypeOf;
    // @ts-expect-error — speculativeConstOf is not on StaticDfaQuery
    restricted.speculativeConstOf;
  });
});
