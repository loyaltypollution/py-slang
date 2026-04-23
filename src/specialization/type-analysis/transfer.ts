import {
  type IntRef,
  BoolRef,
  type TypeLattice,
  INT_BIT,
  BOOL_BIT,
  STR_BIT,
  NULL_BIT,
  CLOSURE_BIT,
  FLOAT_BIT,
  COMPLEX_BIT,
  TOP,
  integer,
  boolValue,
  floatValue,
  COMPLEX,
} from "./lattice";

// Kinds that compare by numeric value (Python: bool is a subclass of int,
// and int/float/complex compare numerically). String, None, closure do not.
const NUMERIC_MASK = INT_BIT | BOOL_BIT | FLOAT_BIT | COMPLEX_BIT;

// Sign arithmetic tables (IntRef × IntRef → IntRef).
// IntRef: 0=Bot 1=Neg 2=Zero 3=NonPos 4=Pos 5=NonZero 6=NonNeg 7=Top

// prettier-ignore
const ADD_TABLE = new Uint8Array([
// a\b:  Bot Neg Zer Nps Pos Nzr Nng Top
/*Bot*/  0,  0,  0,  0,  0,  0,  0,  0,
/*Neg*/  0,  1,  1,  1,  7,  7,  7,  7,
/*Zer*/  0,  1,  2,  3,  4,  5,  6,  7,
/*Nps*/  0,  1,  3,  3,  7,  7,  7,  7,
/*Pos*/  0,  7,  4,  7,  4,  7,  4,  7,
/*Nzr*/  0,  7,  5,  7,  7,  7,  7,  7,
/*Nng*/  0,  7,  6,  7,  4,  7,  6,  7,
/*Top*/  0,  7,  7,  7,  7,  7,  7,  7,
]);

// prettier-ignore
const MUL_TABLE = new Uint8Array([
// a\b:  Bot Neg Zer Nps Pos Nzr Nng Top
/*Bot*/  0,  0,  0,  0,  0,  0,  0,  0,
/*Neg*/  0,  4,  2,  6,  1,  5,  3,  7,
/*Zer*/  0,  2,  2,  2,  2,  2,  2,  2,
/*Nps*/  0,  6,  2,  6,  3,  7,  3,  7,
/*Pos*/  0,  1,  2,  3,  4,  5,  6,  7,
/*Nzr*/  0,  5,  2,  7,  5,  5,  7,  7,
/*Nng*/  0,  3,  2,  3,  6,  7,  6,  7,
/*Top*/  0,  7,  2,  7,  7,  7,  7,  7,
]);

// Floor division: result can be zero, so pos/pos=nonneg, etc.
// Division by zero → top (conservative).
// prettier-ignore
const DIV_TABLE = new Uint8Array([
// a\b:  Bot Neg Zer Nps Pos Nzr Nng Top
/*Bot*/  0,  0,  0,  0,  0,  0,  0,  0,
/*Neg*/  0,  6,  7,  6,  3,  7,  3,  7,
/*Zer*/  0,  2,  7,  2,  2,  2,  2,  7,
/*Nps*/  0,  6,  7,  6,  3,  7,  3,  7,
/*Pos*/  0,  3,  7,  3,  6,  7,  6,  7,
/*Nzr*/  0,  7,  7,  7,  7,  7,  7,  7,
/*Nng*/  0,  3,  7,  3,  6,  7,  6,  7,
/*Top*/  0,  7,  7,  7,  7,  7,  7,  7,
]);

// Python modulo: result sign = divisor sign.
// prettier-ignore
const MOD_TABLE = new Uint8Array([
// a\b:  Bot Neg Zer Nps Pos Nzr Nng Top
/*Bot*/  0,  0,  0,  0,  0,  0,  0,  0,
/*Neg*/  0,  3,  7,  3,  6,  7,  6,  7,
/*Zer*/  0,  2,  7,  2,  2,  2,  2,  7,
/*Nps*/  0,  3,  7,  3,  6,  7,  6,  7,
/*Pos*/  0,  3,  7,  3,  6,  7,  6,  7,
/*Nzr*/  0,  3,  7,  3,  6,  7,  6,  7,
/*Nng*/  0,  3,  7,  3,  6,  7,  6,  7,
/*Top*/  0,  3,  7,  3,  6,  7,  6,  7,
]);

// Boolean comparison tables (IntRef × IntRef → BoolRef).

// GT_TABLE[l][r] = BoolRef of (l > r)
// prettier-ignore
const GT_TABLE = new Uint8Array([
// l\r:  Bot Neg Zer Nps Pos Nzr Nng Top
/*Bot*/  0,  0,  0,  0,  0,  0,  0,  0,
/*Neg*/  0,  3,  2,  3,  2,  3,  2,  3,
/*Zer*/  0,  1,  2,  3,  2,  3,  2,  3,
/*Nps*/  0,  3,  2,  3,  2,  3,  2,  3,
/*Pos*/  0,  1,  1,  1,  3,  3,  3,  3,
/*Nzr*/  0,  3,  3,  3,  3,  3,  3,  3,
/*Nng*/  0,  1,  3,  3,  3,  3,  3,  3,
/*Top*/  0,  3,  3,  3,  3,  3,  3,  3,
]);

// EQ_TABLE[l][r] = BoolRef of (l == r)
// prettier-ignore
const EQ_TABLE = new Uint8Array([
// l\r:  Bot Neg Zer Nps Pos Nzr Nng Top
/*Bot*/  0,  0,  0,  0,  0,  0,  0,  0,
/*Neg*/  0,  3,  2,  3,  2,  3,  2,  3,
/*Zer*/  0,  2,  1,  3,  2,  2,  3,  3,
/*Nps*/  0,  3,  3,  3,  2,  3,  3,  3,
/*Pos*/  0,  2,  2,  2,  3,  3,  3,  3,
/*Nzr*/  0,  3,  2,  3,  3,  3,  3,  3,
/*Nng*/  0,  2,  3,  3,  3,  3,  3,  3,
/*Top*/  0,  3,  3,  3,  3,  3,  3,  3,
]);

/** Negate a sign: swap Neg (bit 0) and Pos (bit 2), keep Zero (bit 1). */
export function negSign(a: IntRef): IntRef {
  return ((a & 2) | ((a & 1) << 2) | ((a & 4) >> 2)) as IntRef;
}

export function addSigns(a: IntRef, b: IntRef): IntRef {
  return ADD_TABLE[(a << 3) | b] as IntRef;
}

export function subSigns(a: IntRef, b: IntRef): IntRef {
  return addSigns(a, negSign(b));
}

export function mulSigns(a: IntRef, b: IntRef): IntRef {
  return MUL_TABLE[(a << 3) | b] as IntRef;
}

export function divSigns(a: IntRef, b: IntRef): IntRef {
  return DIV_TABLE[(a << 3) | b] as IntRef;
}

export function modSigns(a: IntRef, b: IntRef): IntRef {
  return MOD_TABLE[(a << 3) | b] as IntRef;
}

export function notBoolRef(t: BoolRef): BoolRef {
  // Swap True (bit 0) and False (bit 1). Bottom (0) maps to itself.
  return (((t & 1) << 1) | ((t & 2) >> 1)) as BoolRef;
}

export function gtSigns(l: IntRef, r: IntRef): BoolRef {
  return GT_TABLE[(l << 3) | r] as BoolRef;
}

export function ltSigns(l: IntRef, r: IntRef): BoolRef {
  return gtSigns(r, l);
}
export function geSigns(l: IntRef, r: IntRef): BoolRef {
  return notBoolRef(ltSigns(l, r));
}
export function leSigns(l: IntRef, r: IntRef): BoolRef {
  return notBoolRef(gtSigns(l, r));
}

export function eqSigns(l: IntRef, r: IntRef): BoolRef {
  return EQ_TABLE[(l << 3) | r] as BoolRef;
}

export function neqSigns(l: IntRef, r: IntRef): BoolRef {
  return notBoolRef(eqSigns(l, r));
}

// Top-level transfer functions operating on TypeLattice.

/** Apply a sign-arithmetic operator; returns `undefined` for unknown ops. */
function applySignOp(op: string, lRef: IntRef, rRef: IntRef): IntRef | undefined {
  switch (op) {
    case "+": return addSigns(lRef, rRef);
    case "-": return subSigns(lRef, rRef);
    case "*": return mulSigns(lRef, rRef);
    case "//": return divSigns(lRef, rRef);
    case "%": return modSigns(lRef, rRef);
    default: return undefined;
  }
}

export function transferBinaryOp(op: string, left: TypeLattice, right: TypeLattice): TypeLattice {
  const lk = left.kinds;
  const rk = right.kinds;

  // Complex promotion: spec only defines +, -, *, / for complex.
  // // and % raise TypeError at runtime.
  if (lk === COMPLEX_BIT || rk === COMPLEX_BIT) {
    if (op === "//" || op === "%") return TOP;
    const otherKinds = lk === COMPLEX_BIT ? rk : lk;
    // complex op numeric = complex; complex op non-numeric = TOP
    if (otherKinds & ~(INT_BIT | FLOAT_BIT | COMPLEX_BIT)) return TOP;
    return COMPLEX;
  }

  const lIsFloat = lk === FLOAT_BIT;
  const rIsFloat = rk === FLOAT_BIT;
  const lIsInt = lk === INT_BIT;
  const rIsInt = rk === INT_BIT;

  // Only pure numeric (int/float) kinds participate in sign-tracked arithmetic.
  if (!(lIsInt || lIsFloat) || !(rIsInt || rIsFloat)) return TOP;

  const lRef = lIsFloat ? left.floatRef : left.intRef;
  const rRef = rIsFloat ? right.floatRef : right.intRef;

  // True division always returns float (per spec).
  if (op === "/") return floatValue(divSigns(lRef, rRef));

  const resultRef = applySignOp(op, lRef, rRef);
  if (resultRef === undefined) return TOP;

  // Float result whenever either operand is float; otherwise pure int.
  return lIsFloat || rIsFloat ? floatValue(resultRef) : integer(resultRef);
}

export function transferCompare(op: string, left: TypeLattice, right: TypeLattice): TypeLattice {
  const lk = left.kinds;
  const rk = right.kinds;

  // == and != work on any types
  if (op === "==" || op === "!=") {
    // Use sign analysis when both operands are numeric (int or float)
    if ((lk === INT_BIT || lk === FLOAT_BIT) && (rk === INT_BIT || rk === FLOAT_BIT)) {
      const lRef = lk === FLOAT_BIT ? left.floatRef : left.intRef;
      const rRef = rk === FLOAT_BIT ? right.floatRef : right.intRef;
      const ref = op === "==" ? eqSigns(lRef, rRef) : neqSigns(lRef, rRef);
      return boolValue(ref);
    }
    // Disjoint kinds with no numeric crossover → statically unequal.
    // `x == y` is False when no single value could inhabit both sides.
    // Numeric kinds (int/bool/float/complex) compare by value and so must
    // not be treated as disjoint from each other.
    if (
      (lk & rk) === 0 &&
      lk !== 0 &&
      rk !== 0 &&
      !(lk & NUMERIC_MASK && rk & NUMERIC_MASK)
    ) {
      return boolValue(op === "==" ? BoolRef.False : BoolRef.True);
    }
    return boolValue(BoolRef.Top);
  }

  // Ordering comparisons: not valid on complex (raises TypeError at runtime)
  if (lk === COMPLEX_BIT || rk === COMPLEX_BIT) return TOP;

  // Ordering comparisons on any numeric types (int, float, mixed) — sign analysis applies
  // since int and float both use IntRef for their sign refinement.
  if ((lk === INT_BIT || lk === FLOAT_BIT) && (rk === INT_BIT || rk === FLOAT_BIT)) {
    const lRef = lk === FLOAT_BIT ? left.floatRef : left.intRef;
    const rRef = rk === FLOAT_BIT ? right.floatRef : right.intRef;
    switch (op) {
      case ">": return boolValue(gtSigns(lRef, rRef));
      case "<": return boolValue(ltSigns(lRef, rRef));
      case ">=": return boolValue(geSigns(lRef, rRef));
      case "<=": return boolValue(leSigns(lRef, rRef));
    }
  }

  return boolValue(BoolRef.Top);
}

export function transferUnaryNeg(operand: TypeLattice): TypeLattice {
  if (operand.kinds === COMPLEX_BIT) return COMPLEX;
  if (operand.kinds === FLOAT_BIT) return floatValue(negSign(operand.floatRef));
  if (operand.kinds === INT_BIT) return integer(negSign(operand.intRef));
  return TOP;
}

// IntRef-as-truthiness: zero bit → False contribution, nonzero bits → True.
function intRefTruth(r: IntRef): BoolRef {
  if (r === 0) return BoolRef.Bottom;
  const hasZero = (r & 2) !== 0;
  const hasNonzero = (r & 5) !== 0; // Neg | Pos
  if (hasZero && hasNonzero) return BoolRef.Top;
  if (hasZero) return BoolRef.False;
  return BoolRef.True;
}

/**
 * Truthiness over the full kind lattice. Joins per-kind contributions:
 *   None → False, closure → True, bool → boolRef, int/float → intRefTruth,
 *   str/complex → Top (length/nonzero not tracked).
 * Returns BoolRef.Bottom only for the empty lattice.
 */
export function truthiness(t: TypeLattice): BoolRef {
  const k = t.kinds;
  if (k === 0) return BoolRef.Bottom;
  let acc: BoolRef = BoolRef.Bottom;
  if (k & NULL_BIT) acc = (acc | BoolRef.False) as BoolRef;
  if (k & CLOSURE_BIT) acc = (acc | BoolRef.True) as BoolRef;
  if (k & STR_BIT) acc = (acc | BoolRef.Top) as BoolRef;
  if (k & COMPLEX_BIT) acc = (acc | BoolRef.Top) as BoolRef;
  if (k & BOOL_BIT) acc = (acc | t.boolRef) as BoolRef;
  if (k & INT_BIT) acc = (acc | intRefTruth(t.intRef)) as BoolRef;
  if (k & FLOAT_BIT) acc = (acc | intRefTruth(t.floatRef)) as BoolRef;
  return acc;
}

export function transferNot(operand: TypeLattice): TypeLattice {
  // notBoolRef(Bottom) === Bottom, so no Bottom guard needed.
  return boolValue(notBoolRef(truthiness(operand)));
}
