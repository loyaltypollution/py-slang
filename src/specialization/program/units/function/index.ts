// Function-view: the atomic Function unit kind.
//
// - `function.ts`   — the `Function` interface and CFG builders.
// - `manager.ts`    — `FunctionManager` (`UnitDomain<Function,
//                     FunctionLocator>`) plus the `FunctionLocator`
//                     interface and the per-unit chain/refute streams.
// - `slot-table.ts` — slot-lookup over the function's resolved environment.

export * from "./function";
export * from "./manager";
export * from "./slot-table";
