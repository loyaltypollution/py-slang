// Function-view: the atomic Function unit kind.
//
// - `function.ts`   — the `Function` interface and CFG builders.
// - `manager.ts`    — `FunctionManager`: implements `UnitDomain<Function, FunctionLocator>`.
// - `locator.ts`    — `FunctionLocator extends UnitLocator<Function>`.
// - `dispatch.ts`   — per-Function speculation policy (chain state).
// - `slot-table.ts` — slot-lookup over the function's resolved environment.

export * from "./function";
export * from "./manager";
export * from "./locator";
export * from "./dispatch";
export * from "./slot-table";
