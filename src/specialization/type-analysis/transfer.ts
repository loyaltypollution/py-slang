// Transfer functions for type analysis. Sign/boolean refinements are table
// lookups indexed as TABLE[(a << 3) | b] (8x8) or TABLE[(a << 2) | b] (4x4).
import {
  type IntRef,
  BoolRef,
  type TypeLattice,
  INT_BIT,
  BOOL_BIT,
  FLOAT_BIT,
  COMPLEX_BIT,
  TOP,
  integer,
  boolean,
  floatValue,
  COMPLEX,
} from "./lattice";

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
  if (t === 0) return 0 as BoolRef; // bottom
  // Swap True (bit 0) and False (bit 1)
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

  // True division always returns float (per spec)
  if (op === "/") {
    if (lIsInt && rIsInt) {
      return floatValue(divSigns(left.intRef, right.intRef));
    }
    if ((lIsInt || lIsFloat) && (rIsInt || rIsFloat)) {
      const lRef = lIsFloat ? left.floatRef : left.intRef;
      const rRef = rIsFloat ? right.floatRef : right.intRef;
      return floatValue(divSigns(lRef, rRef));
    }
    return TOP;
  }

  // Float + int or float + float → float result
  if ((lIsFloat && rIsInt) || (lIsInt && rIsFloat) || (lIsFloat && rIsFloat)) {
    const lRef = lIsFloat ? left.floatRef : left.intRef;
    const rRef = rIsFloat ? right.floatRef : right.intRef;
    let resultRef: IntRef;
    switch (op) {
      case "+":
        resultRef = addSigns(lRef, rRef);
        break;
      case "-":
        resultRef = subSigns(lRef, rRef);
        break;
      case "*":
        resultRef = mulSigns(lRef, rRef);
        break;
      case "//":
        resultRef = divSigns(lRef, rRef);
        break;
      case "%":
        resultRef = modSigns(lRef, rRef);
        break;
      default:
        return TOP;
    }
    return floatValue(resultRef);
  }

  // Pure int op int
  if (!lIsInt || !rIsInt) return TOP;

  const lRef = left.intRef;
  const rRef = right.intRef;

  let resultRef: IntRef;
  switch (op) {
    case "+":
      resultRef = addSigns(lRef, rRef);
      break;
    case "-":
      resultRef = subSigns(lRef, rRef);
      break;
    case "*":
      resultRef = mulSigns(lRef, rRef);
      break;
    case "//":
      resultRef = divSigns(lRef, rRef);
      break;
    case "%":
      resultRef = modSigns(lRef, rRef);
      break;
    default:
      return TOP;
  }
  return integer(resultRef);
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
      return boolean(ref);
    }
    return boolean(BoolRef.Top);
  }

  // Ordering comparisons: not valid on complex (raises TypeError at runtime)
  if (lk === COMPLEX_BIT || rk === COMPLEX_BIT) return TOP;

  // Ordering comparisons on any numeric types (int, float, mixed) — sign analysis applies
  // since int and float both use IntRef for their sign refinement.
  if ((lk === INT_BIT || lk === FLOAT_BIT) && (rk === INT_BIT || rk === FLOAT_BIT)) {
    const lRef = lk === FLOAT_BIT ? left.floatRef : left.intRef;
    const rRef = rk === FLOAT_BIT ? right.floatRef : right.intRef;
    let resultRef: BoolRef;
    switch (op) {
      case ">":
        resultRef = gtSigns(lRef, rRef);
        break;
      case "<":
        resultRef = ltSigns(lRef, rRef);
        break;
      case ">=":
        resultRef = geSigns(lRef, rRef);
        break;
      case "<=":
        resultRef = leSigns(lRef, rRef);
        break;
      default:
        return boolean(BoolRef.Top);
    }
    return boolean(resultRef);
  }

  return boolean(BoolRef.Top);
}

export function transferUnaryNeg(operand: TypeLattice): TypeLattice {
  if (operand.kinds === COMPLEX_BIT) return COMPLEX;
  if (operand.kinds === FLOAT_BIT) return floatValue(negSign(operand.floatRef));
  if (operand.kinds === INT_BIT) return integer(negSign(operand.intRef));
  return TOP;
}

export function transferNot(operand: TypeLattice): TypeLattice {
  if (!(operand.kinds & BOOL_BIT)) return boolean(BoolRef.Top);
  return boolean(notBoolRef(operand.boolRef));
}
