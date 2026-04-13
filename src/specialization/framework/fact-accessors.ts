// Thin free-function accessors over the shared `FactStore`, one per
// former `OptimizationHint` field. Each accessor resolves the owning
// `Pass<K, V>` and returns `undefined` when no fact has been written,
// distinguishing "missing" from "written lattice.bottom" (which
// `FactStore.read` collapses).

import type { ConstLattice } from "../const-analysis/lattice";
import type { TypeLattice } from "../type-analysis/lattice";
import type { FactStore } from "./fact-store";
import {
  callCountPass,
  constAnalysisPass,
  purityScopePass,
  typeAnalysisPass,
} from "./migrated-passes";

export function readTypeFact(fs: FactStore, id: number): TypeLattice | undefined {
  return fs.has(typeAnalysisPass, id) ? fs.read(typeAnalysisPass, id) : undefined;
}

export function writeTypeFact(fs: FactStore, id: number, v: TypeLattice): boolean {
  return fs.write(typeAnalysisPass, id, v);
}

export function readConstFact(fs: FactStore, id: number): ConstLattice | undefined {
  return fs.has(constAnalysisPass, id) ? fs.read(constAnalysisPass, id) : undefined;
}

export function writeConstFact(fs: FactStore, id: number, v: ConstLattice): boolean {
  return fs.write(constAnalysisPass, id, v);
}

export function readPurityFact(fs: FactStore, id: number): boolean | "contested" | undefined {
  return fs.has(purityScopePass, id) ? fs.read(purityScopePass, id) : undefined;
}

export function readCallCountFact(fs: FactStore, id: number): number | undefined {
  return fs.has(callCountPass, id) ? fs.read(callCountPass, id) : undefined;
}
