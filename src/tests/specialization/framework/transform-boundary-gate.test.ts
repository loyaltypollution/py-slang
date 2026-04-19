import fs from "node:fs";
import path from "node:path";

const TRANSFORMS_DIR = path.resolve(__dirname, "../../../specialization/transforms");
const TRANSFORM_FILES = fs.readdirSync(TRANSFORMS_DIR)
  .filter(name => name.endsWith(".ts"))
  .map(name => path.join(TRANSFORMS_DIR, name));

describe("transform boundary gate", () => {
  test("transforms stay on the root-only fact surface", () => {
    for (const file of TRANSFORM_FILES) {
      const src = fs.readFileSync(file, "utf8");
      expect(src).not.toMatch(/\.store\./);
      expect(src).not.toMatch(/\bROOT_CONTEXT\b/);
      expect(src).not.toMatch(/\bspeculativeTypeOf\b/);
      expect(src).not.toMatch(/\bspeculativeConstOf\b/);
      expect(src).not.toMatch(/from\s+["'][^"']*dfa-factory["']/);
      expect(src).not.toMatch(/(?<!\.)\breadExprFact\s*\(/);
    }
  });
});
