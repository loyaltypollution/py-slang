import type { Analysis } from "../../../specialization/framework/analysis";
import { constExprHandle } from "../../../specialization/const-analysis/analysis";
import { typeExprHandle } from "../../../specialization/type-analysis/analysis";
import {
  returnKindHandle,
  typeRequirementAnalysis,
} from "../../../specialization/type-requirement-analysis/analysis";
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

// Each analysis must declare its merge polarity. The field mirrors
// BlockDfaSpec.mergeKind for DFA wrappers and adds "opaque" for analyses
// whose writes aren't a lattice-refining semantic (runtime observations,
// backend hooks). A missed declaration is a compile-time error; this
// suite pins the *expected* value so re-classifying an analysis is visible.
describe("Analysis.polarity", () => {
  const cases: ReadonlyArray<{
    name: string;
    analysis: Analysis<any, any>;
    expected: "may" | "must" | "opaque";
  }> = [
    { name: "constExprHandle",         analysis: constExprHandle,          expected: "may"    },
    { name: "typeExprHandle",          analysis: typeExprHandle,           expected: "may"    },
    { name: "returnKindHandle",        analysis: returnKindHandle,         expected: "may"    },
    { name: "purityScopeAnalysis",     analysis: purityScopeAnalysis,      expected: "may"    },
    { name: "typeAnalysis",            analysis: typeAnalysis,             expected: "may"    },
    { name: "constAnalysis",           analysis: constAnalysis,            expected: "may"    },
    { name: "livenessAnalysis",        analysis: livenessAnalysis,         expected: "may"    },
    { name: "purityBlockAnalysis",     analysis: purityBlockAnalysis,      expected: "may"    },
    { name: "typeRequirementAnalysis", analysis: typeRequirementAnalysis,  expected: "must"   },
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
    expect(mustAnalyses.map(c => c.name)).toEqual(["typeRequirementAnalysis"]);
  });
});
