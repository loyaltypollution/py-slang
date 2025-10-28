/**
 * Script to generate parser from Peggy grammar
 *
 * This reads the python.peggy file and generates a TypeScript parser.
 */

const fs = require("fs");
const path = require("path");
const peggy = require("peggy");

const GRAMMAR_FILE = path.join(__dirname, "../src/peggy/python.peggy");
const OUTPUT_FILE = path.join(__dirname, "../src/peggy/generated-parser.ts");

console.log("Generating parser from Peggy grammar...");

try {
  // Read the grammar file
  const grammarSource = fs.readFileSync(GRAMMAR_FILE, "utf-8");

  // Generate the parser
  const parser = peggy.generate(grammarSource, {
    output: "source",
    format: "es",
    trace: false,
  });

  const grammarAst = peggy.parser.parse(grammarSource);

  function collectMakeExprTypes(expr: any, types = new Set()) {
    if (!expr) return types;

    // Check for function call nodes
    if (expr.type === "action") {
      // expr.code contains the JS code in { ... }
      const code = expr.code;

      // Simple parse of first argument to makeExpr
      const match = code.match(/makeExpr\s*\(\s*['"`]([a-zA-Z0-9_]+)['"`]/);
      if (match) {
        types.add(match[1]);
      }
    }

    // Recurse into subexpressions
    for (const key in expr) {
      const val = expr[key];
      if (Array.isArray(val)) {
        val.forEach((v) => collectMakeExprTypes(v, types));
      } else if (val && typeof val === "object") {
        collectMakeExprTypes(val, types);
      }
    }

    return types;
  }

  // Generate Visitor<T> interface for ExprNS
  const typesSet = new Set();
  for (const rule of grammarAst.rules) {
    collectMakeExprTypes(rule.expression, typesSet);
  }

  // Wrap in TypeScript module
  const tsModule = `/**
  * AUTO-GENERATED FILE - DO NOT EDIT
  * Generated from python.peggy
  * 
  * To regenerate: npm run gen:peggy
  */
 
 // @ts-nocheck
 ${parser}`;

  // Write the output file
  fs.writeFileSync(OUTPUT_FILE, tsModule);

  console.log(`✓ Parser generated successfully: ${OUTPUT_FILE}`);
  console.log(`  Grammar: ${GRAMMAR_FILE}`);
  console.log(`  Output: ${OUTPUT_FILE}`);
} catch (error) {
  console.error("✗ Failed to generate parser:");
  if (error instanceof Error) {
    console.error(`  ${error.message}`);
    if ("location" in error) {
      const loc = (error as any).location;
      console.error(`  At line ${loc.start.line}, column ${loc.start.column}`);
    }
  }
  process.exit(1);
}
