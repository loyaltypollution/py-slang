// Speculation: what chains *do*. Forked bodies under a chain
// (`assumption-bodies`) and the static "is this chain still valid? which
// body do I emit?" resolution (`chain-dispatch`).
//
// The `assumption/` folder defines the chain values themselves; this
// folder is the runtime mechanism that uses them.

export { forkBody, visibleBody } from "./assumption-bodies";
export { bodyToCompile, dispatchValid } from "./chain-dispatch";
