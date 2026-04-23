import {
  transferBinaryOp,
  transferUnaryNeg,
  transferCompare,
  transferNot,
  negSign,
  addSigns,
  subSigns,
  mulSigns,
  divSigns,
  modSigns,
  gtSigns,
  ltSigns,
  geSigns,
  leSigns,
  eqSigns,
  neqSigns,
  notBoolRef,
} from "../../specialization/type-analysis/transfer";
import {
  INT_POS,
  INT_NEG,
  INT_ZERO,
  BOOL_TRUE,
  BOOL_FALSE,
  FLOAT_POS,
  FLOAT_NEG,
  FLOAT_ZERO,
  COMPLEX,
  STRING,
  TOP,
  IntRef,
  BoolRef,
  INT_BIT,
  BOOL_BIT,
  FLOAT_BIT,
  COMPLEX_BIT,
} from "../../specialization/type-analysis/lattice";

describe("transferBinaryOp", () => {
  test("pos + pos = pos", () => {
    const result = transferBinaryOp("+", INT_POS, INT_POS);
    expect(result.kinds).toBe(INT_BIT);
    expect(result.intRef).toBe(IntRef.Pos);
  });

  test("pos + neg = int (top refinement)", () => {
    const result = transferBinaryOp("+", INT_POS, INT_NEG);
    expect(result.kinds).toBe(INT_BIT);
    expect(result.intRef).toBe(IntRef.Top);
  });

  test("unknown + unknown = unknown", () => {
    const result = transferBinaryOp("+", TOP, TOP);
    expect(result.kinds).toBe(TOP.kinds);
  });
});

describe("transferCompare", () => {
  test("pos > zero = true", () => {
    const result = transferCompare(">", INT_POS, INT_ZERO);
    expect(result.kinds).toBe(BOOL_BIT);
    expect(result.boolRef).toBe(BoolRef.True);
  });

  test("pos > pos = bool (unknown)", () => {
    const result = transferCompare(">", INT_POS, INT_POS);
    expect(result.kinds).toBe(BOOL_BIT);
    expect(result.boolRef).toBe(BoolRef.Top);
  });
});

describe("transferNot", () => {
  test("not True = False", () => {
    const result = transferNot(BOOL_TRUE);
    expect(result.boolRef).toBe(BoolRef.False);
  });

  test("not False = True", () => {
    const result = transferNot(BOOL_FALSE);
    expect(result.boolRef).toBe(BoolRef.True);
  });
});

describe("transferUnaryNeg", () => {
  test("-pos = neg", () => {
    const result = transferUnaryNeg(INT_POS);
    expect(result.intRef).toBe(IntRef.Neg);
  });

  test("-zero = zero", () => {
    const result = transferUnaryNeg(INT_ZERO);
    expect(result.intRef).toBe(IntRef.Zero);
  });
});

const ALL_INT_REFS: IntRef[] = [
  IntRef.Bottom,
  IntRef.Neg,
  IntRef.Zero,
  IntRef.Pos,
  IntRef.NonZero,
  IntRef.NonNeg,
  IntRef.NonPos,
  IntRef.Top,
];
const ALL_BOOL_REFS: BoolRef[] = [BoolRef.Bottom, BoolRef.True, BoolRef.False, BoolRef.Top];

describe("Sign lattice algebraic properties", () => {
  const INT_PAIRS = ALL_INT_REFS.flatMap(a => ALL_INT_REFS.map(b => [a, b] as [IntRef, IntRef]));

  test.each(ALL_INT_REFS)("negSign(negSign(%s)) = %s", a => {
    expect(negSign(negSign(a))).toBe(a);
  });

  test.each(INT_PAIRS)("gtSigns(%s, %s) === ltSigns(%s, %s)", (a, b) => {
    expect(gtSigns(a, b)).toBe(ltSigns(b, a));
  });

  test.each(INT_PAIRS)("geSigns(%s, %s) === notBoolRef(ltSigns(%s, %s))", (a, b) => {
    expect(geSigns(a, b)).toBe(notBoolRef(ltSigns(a, b)));
  });
  test.each(INT_PAIRS)("leSigns(%s, %s) === notBoolRef(gtSigns(%s, %s))", (a, b) => {
    expect(leSigns(a, b)).toBe(notBoolRef(gtSigns(a, b)));
  });

  test.each(INT_PAIRS)("neqSigns(%s, %s) === notBoolRef(eqSigns(%s, %s))", (a, b) => {
    expect(neqSigns(a, b)).toBe(notBoolRef(eqSigns(a, b)));
  });

  test.each(INT_PAIRS)("eqSigns(%s, %s) === eqSigns(%s, %s)", (a, b) => {
    expect(eqSigns(a, b)).toBe(eqSigns(b, a));
  });

  test.each(INT_PAIRS)("addSigns(%s, %s) === addSigns(%s, %s)", (a, b) => {
    expect(addSigns(a, b)).toBe(addSigns(b, a));
  });

  test.each(INT_PAIRS)("mulSigns(%s, %s) === mulSigns(%s, %s)", (a, b) => {
    expect(mulSigns(a, b)).toBe(mulSigns(b, a));
  });

  test.each(ALL_INT_REFS)("addSigns(%s, zero) = %s", a => {
    expect(addSigns(a, IntRef.Zero)).toBe(a);
  });

  test.each(ALL_INT_REFS.filter(a => a !== IntRef.Bottom))("mulSigns(%s, zero) = zero", a => {
    expect(mulSigns(a, IntRef.Zero)).toBe(IntRef.Zero);
  });

  test.each(ALL_INT_REFS)("addSigns(bottom, %s) = bottom", a => {
    expect(addSigns(IntRef.Bottom, a)).toBe(IntRef.Bottom);
  });
  test.each(ALL_INT_REFS)("mulSigns(bottom, %s) = bottom", a => {
    expect(mulSigns(IntRef.Bottom, a)).toBe(IntRef.Bottom);
  });

  test.each(ALL_BOOL_REFS)("notBoolRef(notBoolRef(%s)) = %s", a => {
    expect(notBoolRef(notBoolRef(a))).toBe(a);
  });

  test.each(INT_PAIRS)("subSigns(%s, %s) === addSigns(%s, negSign(%s))", (a, b) => {
    expect(subSigns(a, b)).toBe(addSigns(a, negSign(b)));
  });
});

describe("divSigns golden table", () => {
  // Floor division: 1//3=0, so pos//pos is nonneg, not pos
  const DIV_TABLE: Array<[IntRef, IntRef, IntRef]> = [
    // a,              b,              expected
    [IntRef.Pos, IntRef.Pos, IntRef.NonNeg],
    [IntRef.Neg, IntRef.Neg, IntRef.NonNeg],
    [IntRef.Pos, IntRef.Neg, IntRef.NonPos],
    [IntRef.Neg, IntRef.Pos, IntRef.NonPos],
    [IntRef.Zero, IntRef.Pos, IntRef.Zero],
    [IntRef.Zero, IntRef.Neg, IntRef.Zero],
    [IntRef.Pos, IntRef.Zero, IntRef.Top], // division by zero
    [IntRef.Neg, IntRef.Zero, IntRef.Top], // division by zero
    [IntRef.Zero, IntRef.Zero, IntRef.Top], // 0/0
    [IntRef.NonNeg, IntRef.Pos, IntRef.NonNeg],
    [IntRef.NonPos, IntRef.Neg, IntRef.NonNeg],
    [IntRef.NonNeg, IntRef.Neg, IntRef.NonPos],
    [IntRef.NonPos, IntRef.Pos, IntRef.NonPos],
    [IntRef.Top, IntRef.Pos, IntRef.Top],
    [IntRef.Pos, IntRef.Top, IntRef.Top],
    [IntRef.Bottom, IntRef.Pos, IntRef.Bottom],
    [IntRef.Pos, IntRef.Bottom, IntRef.Bottom],
  ];

  test.each(DIV_TABLE)("divSigns(%s, %s) = %s", (a, b, expected) => {
    expect(divSigns(a, b)).toBe(expected);
  });
});

describe("modSigns golden table (Python floor-mod semantics)", () => {
  const MOD_TABLE: Array<[IntRef, IntRef, IntRef]> = [
    [IntRef.Pos, IntRef.Pos, IntRef.NonNeg],
    [IntRef.Neg, IntRef.Pos, IntRef.NonNeg],
    [IntRef.Pos, IntRef.Neg, IntRef.NonPos],
    [IntRef.Neg, IntRef.Neg, IntRef.NonPos],
    [IntRef.Zero, IntRef.Pos, IntRef.Zero],
    [IntRef.Zero, IntRef.Neg, IntRef.Zero],
    [IntRef.Pos, IntRef.Zero, IntRef.Top], // mod by zero
    [IntRef.Pos, IntRef.Top, IntRef.Top],
  ];
  test.each(MOD_TABLE)("modSigns(%s, %s) = %s", (a, b, expected) => {
    expect(modSigns(a, b)).toBe(expected);
  });
});

describe("Comparison edge cases", () => {
  test("pos > zero = true", () => expect(gtSigns(IntRef.Pos, IntRef.Zero)).toBe(BoolRef.True));
  test("pos > neg = true", () => expect(gtSigns(IntRef.Pos, IntRef.Neg)).toBe(BoolRef.True));
  test("pos > nonpos = true", () => expect(gtSigns(IntRef.Pos, IntRef.NonPos)).toBe(BoolRef.True));
  test("nonneg > neg = true", () => expect(gtSigns(IntRef.NonNeg, IntRef.Neg)).toBe(BoolRef.True));
  test("zero > neg = true", () => expect(gtSigns(IntRef.Zero, IntRef.Neg)).toBe(BoolRef.True));

  test("neg < zero = true", () => expect(ltSigns(IntRef.Neg, IntRef.Zero)).toBe(BoolRef.True));
  test("neg < pos = true", () => expect(ltSigns(IntRef.Neg, IntRef.Pos)).toBe(BoolRef.True));

  test("zero == zero = true", () => expect(eqSigns(IntRef.Zero, IntRef.Zero)).toBe(BoolRef.True));
  test("pos == neg = false", () => expect(eqSigns(IntRef.Pos, IntRef.Neg)).toBe(BoolRef.False));
  test("pos == zero = false", () => expect(eqSigns(IntRef.Pos, IntRef.Zero)).toBe(BoolRef.False));
  test("pos != neg = true", () => expect(neqSigns(IntRef.Pos, IntRef.Neg)).toBe(BoolRef.True));
  test("zero != zero = false", () =>
    expect(neqSigns(IntRef.Zero, IntRef.Zero)).toBe(BoolRef.False));

  test("pos > pos = top", () => expect(gtSigns(IntRef.Pos, IntRef.Pos)).toBe(BoolRef.Top));
  test("nonneg > zero = top", () => expect(gtSigns(IntRef.NonNeg, IntRef.Zero)).toBe(BoolRef.Top));
  test("nonneg > nonneg = top", () =>
    expect(gtSigns(IntRef.NonNeg, IntRef.NonNeg)).toBe(BoolRef.Top));
  test("top > top = top", () => expect(gtSigns(IntRef.Top, IntRef.Top)).toBe(BoolRef.Top));
  test("pos == pos = top", () => expect(eqSigns(IntRef.Pos, IntRef.Pos)).toBe(BoolRef.Top));

  test("nonneg > zero is NOT true (0 > 0 = false)", () => {
    expect(gtSigns(IntRef.NonNeg, IntRef.Zero)).not.toBe(BoolRef.True);
  });
});

describe("transferBinaryOp with floats", () => {
  test("float + float = float (sign top)", () => {
    const result = transferBinaryOp("+", FLOAT_POS, FLOAT_NEG);
    expect(result.kinds).toBe(FLOAT_BIT);
    expect(result.floatRef).toBe(IntRef.Top);
  });

  test("posFloat + posFloat = posFloat", () => {
    const result = transferBinaryOp("+", FLOAT_POS, FLOAT_POS);
    expect(result.kinds).toBe(FLOAT_BIT);
    expect(result.floatRef).toBe(IntRef.Pos);
  });

  test("int + float = float (per spec: promotion)", () => {
    const result = transferBinaryOp("+", INT_POS, FLOAT_POS);
    expect(result.kinds).toBe(FLOAT_BIT);
  });

  test("float / float = float", () => {
    const result = transferBinaryOp("/", FLOAT_POS, FLOAT_POS);
    expect(result.kinds).toBe(FLOAT_BIT);
  });

  test("int / int = float (per spec: true division)", () => {
    const result = transferBinaryOp("/", INT_POS, INT_POS);
    expect(result.kinds).toBe(FLOAT_BIT);
  });
});

describe("transferBinaryOp with complex", () => {
  test("complex + anything numeric = complex", () => {
    const result = transferBinaryOp("+", COMPLEX, INT_POS);
    expect(result.kinds).toBe(COMPLEX_BIT);
  });

  test("int + complex = complex", () => {
    const result = transferBinaryOp("+", INT_POS, COMPLEX);
    expect(result.kinds).toBe(COMPLEX_BIT);
  });

  test("float + complex = complex", () => {
    const result = transferBinaryOp("+", FLOAT_POS, COMPLEX);
    expect(result.kinds).toBe(COMPLEX_BIT);
  });

  test("complex // int = TOP (not valid per spec)", () => {
    const result = transferBinaryOp("//", COMPLEX, INT_POS);
    expect(result).toBe(TOP);
  });

  test("complex % int = TOP (not valid per spec)", () => {
    const result = transferBinaryOp("%", COMPLEX, INT_POS);
    expect(result).toBe(TOP);
  });

  test("complex + string = TOP (non-numeric)", () => {
    const result = transferBinaryOp("+", COMPLEX, STRING);
    expect(result).toBe(TOP);
  });
});

describe("transferCompare with floats", () => {
  test("posFloat > zeroFloat = true", () => {
    const result = transferCompare(">", FLOAT_POS, FLOAT_ZERO);
    expect(result.boolRef).toBe(BoolRef.True);
  });

  test("posInt > posFloat = top (both positive, could be either)", () => {
    const result = transferCompare(">", INT_POS, FLOAT_POS);
    expect(result.kinds).toBe(BOOL_BIT);
    expect(result.boolRef).toBe(BoolRef.Top);
  });

  test("posInt > zeroFloat = true (mixed int/float sign analysis)", () => {
    const result = transferCompare(">", INT_POS, FLOAT_ZERO);
    expect(result.kinds).toBe(BOOL_BIT);
    expect(result.boolRef).toBe(BoolRef.True);
  });

  test("posInt == negFloat = false (mixed int/float sign analysis)", () => {
    const result = transferCompare("==", INT_POS, FLOAT_NEG);
    expect(result.kinds).toBe(BOOL_BIT);
    expect(result.boolRef).toBe(BoolRef.False);
  });
});

describe("transferUnaryNeg with float", () => {
  test("-posFloat = negFloat", () => {
    const result = transferUnaryNeg(FLOAT_POS);
    expect(result.kinds).toBe(FLOAT_BIT);
    expect(result.floatRef).toBe(IntRef.Neg);
  });
});
