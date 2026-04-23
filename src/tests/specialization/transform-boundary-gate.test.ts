import fs from "node:fs";
import path from "node:path";

const TRANSFORMS_DIR = path.resolve(__dirname, "../../specialization/transforms");
const TRANSFORM_FILES = fs.readdirSync(TRANSFORMS_DIR)
  .filter(name => name.endsWith(".ts"))
  .map(name => path.join(TRANSFORMS_DIR, name));

describe("transform boundary gate", () => {
  test("transforms stay on the analysis-based fact surface", () => {
    for (const file of TRANSFORM_FILES) {
      const src = fs.readFileSync(file, "utf8");
      // Direct store access is the only reading escape hatch once analyses
      // own the read surface. Transforms must go through analysis methods.
      expect(src).not.toMatch(/\.store\./);
      // The dfa-query speculative side-channel pre-dates these analysis
      // reads and must remain forbidden.
      expect(src).not.toMatch(/\bspeculativeTypeOf\b/);
      expect(src).not.toMatch(/\bspeculativeConstOf\b/);
      // Transforms never import the dfa-factory directly; block DFA reads
      // go through `analysis.perExpr(topology).readMinimal(chain, ...)`.
      expect(src).not.toMatch(/from\s+["'][^"']*dfa-factory["']/);
      // `ROOT_CONTEXT` is legal in transforms — profile/runtime counters
      // are ROOT-keyed by design, and explicit `counter.at(key)` at the call
      // site makes the policy channel visibly distinct from semantic proof.
      // No gate on the identifier.
    }
  });
});
