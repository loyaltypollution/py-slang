import type { NodeSet } from "../node-set";

/** Marker for concrete program regions (Function, BasicBlock, ...). A View is
 *  a NodeSet with stable identity by object reference and kind-specific
 *  structure. Not every NodeSet is a View — singleton-node sets,
 *  EMPTY_NODESET, and ANY_NODESET are routing helpers, not program views.
 *
 *  `View` is the *only* universal contract here. Per-kind machinery
 *  (registries, lookup surfaces, rebuild scheduling, speculation policy) is
 *  answered separately for each kind by whatever object actually owns it —
 *  there is no blessed generic "manager" interface. Today: `Function` is
 *  owned by `FunctionManager`; `BasicBlock` is materialized by the owning
 *  `Function`'s CFG apparatus and rebuilt wholesale when that function
 *  rebuilds. */
export interface View extends NodeSet {}
