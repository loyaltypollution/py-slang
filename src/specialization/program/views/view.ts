import type { NodeSet } from "../node-set";

/** Marker for concrete program regions (Function, BasicBlock, ...). A View is
 *  a NodeSet with stable identity by object reference and kind-specific
 *  structure. Not every NodeSet is a View — singleton-node sets,
 *  EMPTY_NODESET, and ANY_NODESET are routing helpers, not program views.
 *
 *  Views deliberately do not own:
 *    - global registries (e.g. functions / functionOfNode) — see ViewManager
 *    - lifecycle subscriptions or rebuild scheduling
 *    - speculation/refutation policy unless intrinsic to the kind
 */
export interface View extends NodeSet {}
