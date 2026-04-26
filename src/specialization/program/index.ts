// Public barrel for `specialization/program/`.
//
// Flat layout, organized by responsibility:
//   - `node-set.ts`        — routing primitive (membership / iteration).
//   - `function-extent.ts` — strong-shape snapshot for lifecycle events.
//   - `function/`          — Function (the only swap function) and its CFG /
//                            manager / slot-table machinery. See
//                            `../publication.ts` for the OSR-impossibility
//                            constraint that pins Function as the only kind.
//   - `basic-block.ts`     — subordinate view of a Function's CFG.

export * from "./basic-block";
export * from "./function";
export * from "./function-extent";
export * from "./node-set";

