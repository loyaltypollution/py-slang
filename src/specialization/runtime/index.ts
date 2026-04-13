export type { Lattice } from "./lattice";
export type { Revision } from "./revision";
export { REVISION_ZERO } from "./revision";
export type { Cell, CellState } from "./cell";
export { makeCell } from "./cell";
export { QueryHandle, defineQuery } from "./query";
export { InputHandle, defineInput } from "./input";
export { Db } from "./db";
export * from "./inputs";
export { cfgOf } from "./queries/cfg";
export { typeBlockEnvs, constBlockEnvs } from "./queries/block-envs";
export { kildall } from "./queries/kildall";
export { typeOf } from "./queries/type-of";
export { constOf } from "./queries/const-of";
export { callCountOf, purityOf, shouldMemoize } from "./queries/scope";
export {
  astAfterDeadBranch,
  astAfterConstFold,
  astAfterMemoize,
  optimizedAstOf,
} from "./queries/lowering";
