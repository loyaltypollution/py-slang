import type { Analysis } from "../../specialization/framework/analysis";
import { typeRequirementAnalysis } from "../../specialization/type-requirement-analysis/analysis";
import {
  constAnalysis,
  typeAnalysis,
} from "../../specialization/framework/dfa-analyses";
import { livenessAnalysis } from "../../specialization/liveness-analysis/analysis";
import { definitelyBoundAnalysis } from "../../specialization/definitely-bound-analysis/analysis";
import {
  purityBlockAnalysis,
  purityScopeAnalysis,
} from "../../specialization/purity-analysis/analysis";

// Each Analysis must declare its merge polarity. The field mirrors
// BlockDfaSpec.mergeKind for DFA wrappers. A missed declaration is a
// compile-time error; this suite pins the *expected* value so re-classifying
// an analysis is visible.
//
// Non-fixpoint citizens (`ObservationChannel`, `CounterStore`,
// `TransformRule`, `Narrowing`) are NOT included — they don't
// implement `Analysis` and don't carry a polarity. Adding one here would
// be a category error.
describe("Analysis.polarity", () => {
  const cases: ReadonlyArray<{
    name: string;
    analysis: Analysis<any, any>;
    expected: "may" | "must";
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
    { name: "definitelyBoundAnalysis.env",   analysis: definitelyBoundAnalysis.env,   expected: "must"   },
    { name: "definitelyBoundAnalysis.facts", analysis: definitelyBoundAnalysis.facts, expected: "must"   },
  ];

  test.each(cases)("$name declares polarity $expected", ({ analysis, expected }) => {
    expect(analysis.polarity).toBe(expected);
  });

  test("every registered analysis declares exactly one of may | must", () => {
    for (const { analysis } of cases) {
      expect(["may", "must"]).toContain(analysis.polarity);
    }
  });

  test("must-polarity consumers cover both in-tree must analyses", () => {
    const mustAnalyses = cases.filter(c => c.analysis.polarity === "must");
    expect(mustAnalyses.map(c => c.name)).toEqual([
      "typeRequirementAnalysis.env",
      "typeRequirementAnalysis.facts",
      "definitelyBoundAnalysis.env",
      "definitelyBoundAnalysis.facts",
    ]);
  });
});
