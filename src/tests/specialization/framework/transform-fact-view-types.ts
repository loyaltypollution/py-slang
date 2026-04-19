import type { TransformFactView } from "../../../specialization/framework/analysis";
import { constAnalysis } from "../../../specialization/framework/dfa-analyses";
import { runtimeCallAnalysis } from "../../../specialization/framework/runtime-analyses";

declare const facts: TransformFactView;

facts.readAll(constAnalysis.facts);
facts.readProfitability(runtimeCallAnalysis, 0);

// @ts-expect-error opaque analyses must use readProfitability, not read
facts.read(runtimeCallAnalysis, 0);
