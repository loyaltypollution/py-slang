export const INT_BIT = 1;
export const BOOL_BIT = 2;
export const STR_BIT = 4;
export const NULL_BIT = 8;
export const CLOSURE_BIT = 16;
export const FLOAT_BIT = 32;
export const COMPLEX_BIT = 64;
export const ALL_KINDS_MASK =
  INT_BIT | BOOL_BIT | STR_BIT | NULL_BIT | CLOSURE_BIT | FLOAT_BIT | COMPLEX_BIT;

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

export interface TypeLattice {
  readonly kinds: number;
  readonly intRef: IntRef;
  readonly boolRef: BoolRef;
  readonly floatRef: IntRef; // reuses IntRef enum for sign refinement
}

// IntRef/BoolRef are bit-subset lattices: join = OR, meet = AND, leq = subset.

export function join(a: TypeLattice, b: TypeLattice): TypeLattice {
  if (a === b) return a;
  const kinds = a.kinds | b.kinds;
  const intRef = kinds & INT_BIT ? ((a.intRef | b.intRef) as IntRef) : (0 as IntRef);
  const boolRef = kinds & BOOL_BIT ? ((a.boolRef | b.boolRef) as BoolRef) : (0 as BoolRef);
  const floatRef = kinds & FLOAT_BIT ? ((a.floatRef | b.floatRef) as IntRef) : (0 as IntRef);
  return { kinds, intRef, boolRef, floatRef };
}

export function meet(a: TypeLattice, b: TypeLattice): TypeLattice {
  if (a === b) return a;
  const kinds = a.kinds & b.kinds;
  const intRef = kinds & INT_BIT ? ((a.intRef & b.intRef) as IntRef) : (0 as IntRef);
  const boolRef = kinds & BOOL_BIT ? ((a.boolRef & b.boolRef) as BoolRef) : (0 as BoolRef);
  const floatRef = kinds & FLOAT_BIT ? ((a.floatRef & b.floatRef) as IntRef) : (0 as IntRef);
  return { kinds, intRef, boolRef, floatRef };
}

export function leq(a: TypeLattice, b: TypeLattice): boolean {
  if (a === b) return true;
  if ((a.kinds & ~b.kinds) !== 0) return false;
  if (a.kinds & INT_BIT && (a.intRef & b.intRef) !== a.intRef) return false;
  if (a.kinds & BOOL_BIT && (a.boolRef & b.boolRef) !== a.boolRef) return false;
  if (a.kinds & FLOAT_BIT && (a.floatRef & b.floatRef) !== a.floatRef) return false;
  return true;
}

/** Structural equality: antisymmetric closure of `leq`, with an `a === b`
 *  shortcut that hits often (all narrowed types come from `INT_SINGLETONS`,
 *  `BOOL_SINGLETONS`, `FLOAT_SINGLETONS`, or `TOP`/`BOTTOM` — frozen
 *  singletons). Shared between `typeExprHandle.lattice` and
 *  `typeAnalysisModule`. */
export const eq = (a: TypeLattice, b: TypeLattice): boolean =>
  a === b || (leq(a, b) && leq(b, a));

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

// Exported frozen singletons (zero allocation at call sites).
export const STRING: TypeLattice = makeSingleton(STR_BIT, 0 as IntRef, 0 as BoolRef);
export const NULL: TypeLattice = makeSingleton(NULL_BIT, 0 as IntRef, 0 as BoolRef);
export const CLOSURE: TypeLattice = makeSingleton(CLOSURE_BIT, 0 as IntRef, 0 as BoolRef);
export const COMPLEX: TypeLattice = makeSingleton(COMPLEX_BIT, 0 as IntRef, 0 as BoolRef);

export const INT_NEG: TypeLattice = INT_SINGLETONS[1]; // IntRef.Neg
export const INT_ZERO: TypeLattice = INT_SINGLETONS[2]; // IntRef.Zero
export const INT_POS: TypeLattice = INT_SINGLETONS[4]; // IntRef.Pos

export const BOOL_TRUE: TypeLattice = BOOL_SINGLETONS[1]; // BoolRef.True
export const BOOL_FALSE: TypeLattice = BOOL_SINGLETONS[2]; // BoolRef.False

export const FLOAT_NEG: TypeLattice = FLOAT_SINGLETONS[1]; // IntRef.Neg
export const FLOAT_ZERO: TypeLattice = FLOAT_SINGLETONS[2]; // IntRef.Zero
export const FLOAT_POS: TypeLattice = FLOAT_SINGLETONS[4]; // IntRef.Pos

// Parameterized constructors retained (take refinement args).
export function integer(intRef: IntRef = 7 as IntRef): TypeLattice {
  return INT_SINGLETONS[intRef];
}

export function boolValue(ref: BoolRef = 3 as BoolRef): TypeLattice {
  return BOOL_SINGLETONS[ref];
}

/** Default IntRef.Top covers NaN (no meaningful sign). */
export function floatValue(floatRef: IntRef = 7 as IntRef): TypeLattice {
  return FLOAT_SINGLETONS[floatRef];
}
