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

export function normalizeType(v: TypeLattice): TypeLattice {
  let kinds = v.kinds;
  const intRef = (kinds & INT_BIT) !== 0 ? v.intRef : (0 as IntRef);
  const boolRef = (kinds & BOOL_BIT) !== 0 ? v.boolRef : (0 as BoolRef);
  const floatRef = (kinds & FLOAT_BIT) !== 0 ? v.floatRef : (0 as IntRef);

  // When INT_BIT is absent, `intRef` is already 0 above, so clearing a bit
  // not in `kinds` is a no-op — the guards simplify to the conjunct.
  if (intRef === IntRef.Bottom) kinds &= ~INT_BIT;
  if (boolRef === BoolRef.Bottom) kinds &= ~BOOL_BIT;
  if (floatRef === IntRef.Bottom) kinds &= ~FLOAT_BIT;

  if (kinds === 0) return BOTTOM;
  if (kinds === INT_BIT) return INT_SINGLETONS[intRef];
  if (kinds === BOOL_BIT) return BOOL_SINGLETONS[boolRef];
  if (kinds === FLOAT_BIT) return FLOAT_SINGLETONS[floatRef];
  if (
    kinds === ALL_KINDS_MASK
    && intRef === IntRef.Top
    && boolRef === BoolRef.Top
    && floatRef === IntRef.Top
  ) {
    return TOP;
  }

  return Object.freeze({ kinds, intRef, boolRef, floatRef });
}

export function join(a: TypeLattice, b: TypeLattice): TypeLattice {
  if (a === b) return a;
  const kinds = a.kinds | b.kinds;
  const intRef = kinds & INT_BIT ? ((a.intRef | b.intRef) as IntRef) : (0 as IntRef);
  const boolRef = kinds & BOOL_BIT ? ((a.boolRef | b.boolRef) as BoolRef) : (0 as BoolRef);
  const floatRef = kinds & FLOAT_BIT ? ((a.floatRef | b.floatRef) as IntRef) : (0 as IntRef);
  return normalizeType({ kinds, intRef, boolRef, floatRef });
}

export function meet(a: TypeLattice, b: TypeLattice): TypeLattice {
  if (a === b) return a;
  const kinds = a.kinds & b.kinds;
  const intRef = kinds & INT_BIT ? ((a.intRef & b.intRef) as IntRef) : (0 as IntRef);
  const boolRef = kinds & BOOL_BIT ? ((a.boolRef & b.boolRef) as BoolRef) : (0 as BoolRef);
  const floatRef = kinds & FLOAT_BIT ? ((a.floatRef & b.floatRef) as IntRef) : (0 as IntRef);
  return normalizeType({ kinds, intRef, boolRef, floatRef });
}

export function leq(a: TypeLattice, b: TypeLattice): boolean {
  if (a === b) return true;
  if ((a.kinds & ~b.kinds) !== 0) return false;
  if (a.kinds & INT_BIT && (a.intRef & b.intRef) !== a.intRef) return false;
  if (a.kinds & BOOL_BIT && (a.boolRef & b.boolRef) !== a.boolRef) return false;
  if (a.kinds & FLOAT_BIT && (a.floatRef & b.floatRef) !== a.floatRef) return false;
  return true;
}

/** Structural equality with identity shortcut — narrowed types are frozen
 *  singletons, so `a === b` hits often. */
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

const INT_SINGLETONS: TypeLattice[] = Array.from({ length: 8 }, (_, r) =>
  makeSingleton(INT_BIT, r as IntRef, 0 as BoolRef),
);
const BOOL_SINGLETONS: TypeLattice[] = Array.from({ length: 4 }, (_, r) =>
  makeSingleton(BOOL_BIT, 0 as IntRef, r as BoolRef),
);
const FLOAT_SINGLETONS: TypeLattice[] = Array.from({ length: 8 }, (_, r) =>
  makeSingleton(FLOAT_BIT, 0 as IntRef, 0 as BoolRef, r as IntRef),
);

export const TOP: TypeLattice = makeSingleton(ALL_KINDS_MASK, IntRef.Top, BoolRef.Top, IntRef.Top);
export const BOTTOM: TypeLattice = makeSingleton(0, 0 as IntRef, 0 as BoolRef);

export function isSatisfiableType(v: TypeLattice): boolean {
  return normalizeType(v) !== BOTTOM;
}

export const STRING: TypeLattice = makeSingleton(STR_BIT, 0 as IntRef, 0 as BoolRef);
export const NULL: TypeLattice = makeSingleton(NULL_BIT, 0 as IntRef, 0 as BoolRef);
export const CLOSURE: TypeLattice = makeSingleton(CLOSURE_BIT, 0 as IntRef, 0 as BoolRef);
export const COMPLEX: TypeLattice = makeSingleton(COMPLEX_BIT, 0 as IntRef, 0 as BoolRef);

export const INT_NEG: TypeLattice = INT_SINGLETONS[IntRef.Neg];
export const INT_ZERO: TypeLattice = INT_SINGLETONS[IntRef.Zero];
export const INT_POS: TypeLattice = INT_SINGLETONS[IntRef.Pos];

export const BOOL_TRUE: TypeLattice = BOOL_SINGLETONS[BoolRef.True];
export const BOOL_FALSE: TypeLattice = BOOL_SINGLETONS[BoolRef.False];

export const FLOAT_NEG: TypeLattice = FLOAT_SINGLETONS[IntRef.Neg];
export const FLOAT_ZERO: TypeLattice = FLOAT_SINGLETONS[IntRef.Zero];
export const FLOAT_POS: TypeLattice = FLOAT_SINGLETONS[IntRef.Pos];

export function integer(intRef: IntRef = IntRef.Top): TypeLattice {
  return intRef === IntRef.Bottom ? BOTTOM : INT_SINGLETONS[intRef];
}

export function boolValue(ref: BoolRef = BoolRef.Top): TypeLattice {
  return ref === BoolRef.Bottom ? BOTTOM : BOOL_SINGLETONS[ref];
}

/** Default IntRef.Top covers NaN (no meaningful sign). */
export function floatValue(floatRef: IntRef = IntRef.Top): TypeLattice {
  return floatRef === IntRef.Bottom ? BOTTOM : FLOAT_SINGLETONS[floatRef];
}
