/**
 * Synchrony invariant on the worklist's `observeWrite` / `observeCall`
 * surface — enforced at runtime inside `Worklist`'s constructor because
 * TypeScript treats `() => Promise<void>` as assignable to `() => void`.
 *
 * The happy path is covered implicitly by every other worklist test. This
 * file pins the tripwire by monkey-patching the prototype with an async
 * method and asserting construction throws.
 */

import { Worklist } from "../specialization";
import { toPythonAstAndResolve } from "./utils";
import { StmtNS } from "../ast-types";
import { Resolver } from "../resolver";

function buildMinimalArgs() {
  const ast = toPythonAstAndResolve("1\n", 1) as StmtNS.FileInput;
  const resolver = new Resolver("1\n", ast, []);
  resolver.resolve(ast);
  return { ast, fenv: resolver.functionEnvironments };
}

describe("Worklist sink synchrony tripwire", () => {
  test("constructor throws when a sink method is declared async", () => {
    const { ast, fenv } = buildMinimalArgs();
    const orig = Worklist.prototype.observe;
    (Worklist.prototype as unknown as Record<string, unknown>).observe = async function () {};
    try {
      expect(() => new Worklist(ast, fenv)).toThrow(/observe.*synchronous/);
    } finally {
      Worklist.prototype.observe = orig;
    }
  });
});
