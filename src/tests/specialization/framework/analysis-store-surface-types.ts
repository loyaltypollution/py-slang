import { ROOT_CONTEXT } from "../../../specialization/framework/context";
import { runtimeCallAnalysis } from "../../../specialization/framework/runtime-analyses";

runtimeCallAnalysis.store.read(0, ROOT_CONTEXT);

// @ts-expect-error public Analysis.store is read-only; mutation goes through framework helpers
runtimeCallAnalysis.store.evict(0, ROOT_CONTEXT);

// @ts-expect-error public Analysis.store is read-only; mutation goes through framework helpers
runtimeCallAnalysis.store.write(0, 1, ROOT_CONTEXT);
