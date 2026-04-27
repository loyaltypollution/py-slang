// Public barrel for `specialization/program/`.
//
// Flat layout, organized by responsibility:
//   - `node-set.ts`    — routing primitive (membership / iteration).
//   - `function/`      — Function (the only swap unit) and its CFG /
//                        manager / slot-table machinery. See
//                        `../publication.ts` for the OSR-impossibility
//                        constraint that pins Function as the only kind.
//   - `basic-block.ts` — subordinate view of a Function's CFG.

export * from "./node-set";
export * from "./function";
export * from "./basic-block";
