// src/specialization/type-analysis/lattice.ts
//
// Type lattice: bitmask of possible Python types with sign/truth refinements.
// join = OR, meet = AND over the powerset domain.

// ---- Kind bitmask constants ----

export const INT_BIT = 1;
export const BOOL_BIT = 2;
export const STR_BIT = 4;
export const NULL_BIT = 8;
export const CLOSURE_BIT = 16;
export const FLOAT_BIT = 32;
export const COMPLEX_BIT = 64;
export const ALL_KINDS_MASK =
  INT_BIT | BOOL_BIT | STR_BIT | NULL_BIT | CLOSURE_BIT | FLOAT_BIT | COMPLEX_BIT;

// ---- Refinement enums (power-set bitmasks) ----

export const enum IntRef {
  Bottom = 0,
  Neg = 1,
  Zero = 2,
  Pos = 4,
  NonPos = Neg | Zero, // 3
  NonZero = Neg | Pos, // 5
  NonNeg = Zero | Pos, // 6
  Top = Neg | Zero | Pos, // 7
}

export const enum BoolRef {
  Bottom = 0,
  True = 1,
  False = 2,
  Top = True | False, // 3
}

// ---- TypeLattice: the abstract value for type analysis ----

export interface TypeLattice {
  readonly kinds: number;
  readonly intRef: IntRef;
  readonly boolRef: BoolRef;
  readonly floatRef: IntRef; // reuses IntRef enum for sign refinement
}

export type TypeEnv = ReadonlyMap<number, TypeLattice>;

// ---- Lattice operations (pure bitwise) ----

export function joinIntRef(a: IntRef, b: IntRef): IntRef {
  return a | b;
}
export function meetIntRef(a: IntRef, b: IntRef): IntRef {
  return a & b;
}
export function leqIntRef(a: IntRef, b: IntRef): boolean {
  return (a & b) === a;
}

export function joinBoolRef(a: BoolRef, b: BoolRef): BoolRef {
  return a | b;
}
export function meetBoolRef(a: BoolRef, b: BoolRef): BoolRef {
  return a & b;
}
export function leqBoolRef(a: BoolRef, b: BoolRef): boolean {
  return (a & b) === a;
}

// ---- TypeLattice operations ----

export function join(a: TypeLattice, b: TypeLattice): TypeLattice {
  if (a === b) return a;
  const kinds = a.kinds | b.kinds;
  const intRef = kinds & INT_BIT ? joinIntRef(a.intRef, b.intRef) : (0 as IntRef);
  const boolRef = kinds & BOOL_BIT ? joinBoolRef(a.boolRef, b.boolRef) : (0 as BoolRef);
  const floatRef = kinds & FLOAT_BIT ? joinIntRef(a.floatRef, b.floatRef) : (0 as IntRef);
  return { kinds, intRef, boolRef, floatRef };
}

export function meet(a: TypeLattice, b: TypeLattice): TypeLattice {
  if (a === b) return a;
  const kinds = a.kinds & b.kinds;
  const intRef = kinds & INT_BIT ? meetIntRef(a.intRef, b.intRef) : (0 as IntRef);
  const boolRef = kinds & BOOL_BIT ? meetBoolRef(a.boolRef, b.boolRef) : (0 as BoolRef);
  const floatRef = kinds & FLOAT_BIT ? meetIntRef(a.floatRef, b.floatRef) : (0 as IntRef);
  return { kinds, intRef, boolRef, floatRef };
}

export function leq(a: TypeLattice, b: TypeLattice): boolean {
  if (a === b) return true;
  if ((a.kinds & ~b.kinds) !== 0) return false;
  if (a.kinds & INT_BIT && !leqIntRef(a.intRef, b.intRef)) return false;
  if (a.kinds & BOOL_BIT && !leqBoolRef(a.boolRef, b.boolRef)) return false;
  if (a.kinds & FLOAT_BIT && !leqIntRef(a.floatRef, b.floatRef)) return false;
  return true;
}

// ---- Frozen singletons ----

function makeSingleton(
  kinds: number,
  intRef: IntRef,
  boolRef: BoolRef,
  floatRef: IntRef = 0 as IntRef,
): TypeLattice {
  return Object.freeze({ kinds, intRef, boolRef, floatRef });
}

const INT_SINGLETONS: TypeLattice[] = [];
for (let r = 0; r < 8; r++) {
  INT_SINGLETONS[r] = makeSingleton(INT_BIT, r as IntRef, 0 as BoolRef);
}

const BOOL_SINGLETONS: TypeLattice[] = [];
for (let r = 0; r < 4; r++) {
  BOOL_SINGLETONS[r] = makeSingleton(BOOL_BIT, 0 as IntRef, r as BoolRef);
}

const FLOAT_SINGLETONS: TypeLattice[] = [];
for (let r = 0; r < 8; r++) {
  FLOAT_SINGLETONS[r] = makeSingleton(FLOAT_BIT, 0 as IntRef, 0 as BoolRef, r as IntRef);
}

export const TOP: TypeLattice = makeSingleton(
  ALL_KINDS_MASK,
  7 as IntRef,
  3 as BoolRef,
  7 as IntRef,
);
export const BOTTOM: TypeLattice = makeSingleton(0, 0 as IntRef, 0 as BoolRef);
export const STRING_VAL: TypeLattice = makeSingleton(STR_BIT, 0 as IntRef, 0 as BoolRef);
export const NULL_VAL: TypeLattice = makeSingleton(NULL_BIT, 0 as IntRef, 0 as BoolRef);
export const CLOSURE_VAL: TypeLattice = makeSingleton(CLOSURE_BIT, 0 as IntRef, 0 as BoolRef);
export const COMPLEX_VAL: TypeLattice = makeSingleton(COMPLEX_BIT, 0 as IntRef, 0 as BoolRef);

// ---- Constructor functions (zero allocation — singleton lookups) ----

export function integer(intRef: IntRef = 7 as IntRef): TypeLattice {
  return INT_SINGLETONS[intRef];
}
export function positiveInteger(): TypeLattice {
  return INT_SINGLETONS[4];
} // IntRef.Pos
export function negativeInteger(): TypeLattice {
  return INT_SINGLETONS[1];
} // IntRef.Neg
export function zeroInteger(): TypeLattice {
  return INT_SINGLETONS[2];
} // IntRef.Zero

export function boolean(boolRef: BoolRef = 3 as BoolRef): TypeLattice {
  return BOOL_SINGLETONS[boolRef];
}
export function trueValue(): TypeLattice {
  return BOOL_SINGLETONS[1];
} // BoolRef.True
export function falseValue(): TypeLattice {
  return BOOL_SINGLETONS[2];
} // BoolRef.False

/** Default IntRef.Top covers NaN (no meaningful sign). */
export function floatValue(floatRef: IntRef = 7 as IntRef): TypeLattice {
  return FLOAT_SINGLETONS[floatRef];
}
export function positiveFloat(): TypeLattice {
  return FLOAT_SINGLETONS[4]; // IntRef.Pos
}
export function negativeFloat(): TypeLattice {
  return FLOAT_SINGLETONS[1]; // IntRef.Neg
}
export function zeroFloat(): TypeLattice {
  return FLOAT_SINGLETONS[2]; // IntRef.Zero
}

export function complexValue(): TypeLattice {
  return COMPLEX_VAL;
}

export function stringValue(): TypeLattice {
  return STRING_VAL;
}
export function nullValue(): TypeLattice {
  return NULL_VAL;
}
export function closureValue(): TypeLattice {
  return CLOSURE_VAL;
}
