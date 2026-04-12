/**
 * Synchrony invariant on `ObservationSink` — enforced at runtime inside
 * `PersistentWorklist`'s constructor because TypeScript treats
 * `() => Promise<void>` as assignable to `() => void`.
 *
 * The happy path is covered implicitly by every other worklist test. This
 * file pins the tripwire by monkey-patching the prototype with an async
 * method and asserting construction throws.
 */

import { PersistentWorklist } from "../specialization";
import { toPythonAstAndResolve } from "./utils";
import { StmtNS } from "../ast-types";
import { Resolver } from "../resolver";

function buildMinimalArgs() {
  const ast = toPythonAstAndResolve("1\n", 1) as StmtNS.FileInput;
  const resolver = new Resolver("1\n", ast, []);
  resolver.resolve(ast);
  return { ast, fenv: resolver.functionEnvironments };
}

describe("PersistentWorklist sink synchrony tripwire", () => {
  test("constructor throws when a sink method is declared async", () => {
    const { ast, fenv } = buildMinimalArgs();
    const orig = PersistentWorklist.prototype.observeWrite;
    (PersistentWorklist.prototype as unknown as Record<string, unknown>).observeWrite =
      async function () {};
    try {
      expect(() => new PersistentWorklist(ast, fenv, [], [])).toThrow(
        /observeWrite.*synchronous/,
      );
    } finally {
      PersistentWorklist.prototype.observeWrite = orig;
    }
  });
});
