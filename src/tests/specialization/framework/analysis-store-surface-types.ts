import { ROOT_CONTEXT } from "../../../specialization/framework/assumption-chain";
import { purityScopeAnalysis } from "../../../specialization/purity-analysis/analysis";
import { typeAnalysis } from "../../../specialization/framework/dfa-analyses";

purityScopeAnalysis.read(0, ROOT_CONTEXT);

// @ts-expect-error BasicBlock-keyed analyses reject nodeId keys.
typeAnalysis.env.read(0, ROOT_CONTEXT);

// @ts-expect-error AssumptionChain no longer exposes fact reads
ROOT_CONTEXT.read(purityScopeAnalysis, 0);

// @ts-expect-error public Analysis.store is read-only; mutation goes through framework helpers
purityScopeAnalysis.store.evict(0, ROOT_CONTEXT);

// @ts-expect-error public Analysis.store is read-only; mutation goes through framework helpers
purityScopeAnalysis.store.write(0, true, ROOT_CONTEXT);
