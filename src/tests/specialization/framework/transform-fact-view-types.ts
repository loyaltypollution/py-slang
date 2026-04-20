import type { TransformFactView } from "../../../specialization/framework/analysis";
import { constAnalysis } from "../../../specialization/framework/dfa-analyses";
import { runtimeCallAnalysis } from "../../../specialization/framework/runtime-analyses";

declare const facts: TransformFactView;

// Witness-producing reads: readAt (exact positional) and readMinimal
// (walk toward ROOT). These are the only semantic-fact reads; silent ROOT
// fallback helpers were removed.
facts.readAt(constAnalysis.facts, null as any);
facts.readMinimal(constAnalysis.facts, null as any, _ => true);

// Opaque/profitability reads do not participate in the witness contract.
facts.readProfitability(runtimeCallAnalysis, 0);

// @ts-expect-error opaque analyses must use readProfitability, not readAt
facts.readAt(runtimeCallAnalysis, 0);
