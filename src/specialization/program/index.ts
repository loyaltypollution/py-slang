// Public barrel for `specialization/program/`.
//
// Three layers, separated by responsibility:
//   - **primitives** — `NodeSet` (routing) and `UnitExtent` (snapshot).
//   - **units/**     — atomic unit kinds (Function today).
//   - **regions/**   — subordinate views of units (BasicBlock today).

export * from "./node-set";
export * from "./unit-extent";
export * from "./units";
export * from "./regions";
