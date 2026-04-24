// Assumption-chain spine: the values and algebra that define a
// speculation context. Pure data — no Unit, no AST, no worklist. The
// "what does a chain mean at runtime" mechanism lives in speculation/.

export {
  ROOT_CONTEXT,
  isRoot,
  type Assumption,
  type AssumptionChain,
  type NarrowingId,
} from "./chain";

export {
  at,
  carrier,
  extend,
  leq,
  without,
} from "./algebra";

export { ChainInterner } from "./interner";

export { Refutations } from "./refutation";
