import type { Analysis } from "../../../specialization/framework/analysis";
import { typeRequirementAnalysis } from "../../../specialization/type-requirement-analysis/analysis";
import {
  constAnalysis,
  typeAnalysis,
} from "../../../specialization/framework/dfa-analyses";
import { livenessAnalysis } from "../../../specialization/liveness-analysis/analysis";
import {
  purityBlockAnalysis,
  purityScopeAnalysis,
} from "../../../specialization/purity-analysis/analysis";
import {
  runtimeCallAnalysis,
  runtimeReturnAnalysis,
  runtimeWriteAnalysis,
} from "../../../specialization/framework/runtime-analyses";

// Each Analysis must declare its merge polarity. The field mirrors
// BlockDfaSpec.mergeKind for DFA wrappers and adds "opaque" for analyses
// whose writes aren't a lattice-refining semantic (runtime observations,
// backend hooks). A missed declaration is a compile-time error; this
// suite pins the *expected* value so re-classifying an analysis is visible.
//
// `AssumptionHandle`s are NOT included — they don't write to FactStore,
// have no transfer, and no polarity (that's the whole point of the citizen
// split). Adding a handle here would be a category error.
describe("Analysis.polarity", () => {
  const cases: ReadonlyArray<{
    name: string;
    analysis: Analysis<any, any>;
    expected: "may" | "must" | "opaque";
  }> = [
    // Block DFAs are paired `.env` + `.facts` analyses; both cells of a
    // given BFA carry the same polarity (the factory mirrors `mergeKind`
    // onto each). Both are pinned here so a future drift between the pair
    // is caught.
    { name: "purityScopeAnalysis",           analysis: purityScopeAnalysis,           expected: "may"    },
    { name: "typeAnalysis.env",              analysis: typeAnalysis.env,              expected: "may"    },
    { name: "typeAnalysis.facts",            analysis: typeAnalysis.facts,            expected: "may"    },
    { name: "constAnalysis.env",             analysis: constAnalysis.env,             expected: "may"    },
    { name: "constAnalysis.facts",           analysis: constAnalysis.facts,           expected: "may"    },
    { name: "livenessAnalysis.env",          analysis: livenessAnalysis.env,          expected: "may"    },
    { name: "livenessAnalysis.facts",        analysis: livenessAnalysis.facts,        expected: "may"    },
    { name: "purityBlockAnalysis.env",       analysis: purityBlockAnalysis.env,       expected: "may"    },
    { name: "purityBlockAnalysis.facts",     analysis: purityBlockAnalysis.facts,     expected: "may"    },
    { name: "typeRequirementAnalysis.env",   analysis: typeRequirementAnalysis.env,   expected: "must"   },
    { name: "typeRequirementAnalysis.facts", analysis: typeRequirementAnalysis.facts, expected: "must"   },
    { name: "runtimeWriteAnalysis",    analysis: runtimeWriteAnalysis,     expected: "opaque" },
    { name: "runtimeReturnAnalysis",   analysis: runtimeReturnAnalysis,    expected: "opaque" },
    { name: "runtimeCallAnalysis",     analysis: runtimeCallAnalysis,      expected: "opaque" },
  ];

  test.each(cases)("$name declares polarity $expected", ({ analysis, expected }) => {
    expect(analysis.polarity).toBe(expected);
  });

  test("every registered analysis declares exactly one of may | must | opaque", () => {
    for (const { analysis } of cases) {
      expect(["may", "must", "opaque"]).toContain(analysis.polarity);
    }
  });

  test("typeRequirementAnalysis is the only must-polarity consumer today", () => {
    const mustAnalyses = cases.filter(c => c.analysis.polarity === "must");
    expect(mustAnalyses.map(c => c.name)).toEqual([
      "typeRequirementAnalysis.env",
      "typeRequirementAnalysis.facts",
    ]);
  });
});
