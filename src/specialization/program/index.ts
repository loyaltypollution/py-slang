// Public barrel for `specialization/program/`.
//
// Three layers, separated by responsibility:
//   - **primitives** — `NodeSet` (routing) and `FunctionExtent` (snapshot).
//   - **units/**     — Function (the only swap unit; see `../publication.ts`).
//   - **regions/**   — subordinate views of a Function (BasicBlock).

export * from "./node-set";
export * from "./unit-extent";
export * from "./units";
export * from "./regions";
