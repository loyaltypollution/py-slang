import type { NodeSet } from "../node-set";

/** Marker: a NodeSet that names a concrete program region (Function,
 *  BasicBlock). Singleton-node sets and EMPTY/ANY_NODESET are routing
 *  helpers, not Views. */
export interface View extends NodeSet {}
