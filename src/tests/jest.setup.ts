// Jest's worker IPC serializes values via JSON.stringify, which throws on
// BigInt. SVML now produces Python ints as bigint; this shim lets error
// messages and reporter output carry bigint values without crashing the
// worker. Applied to a prototype-like extension on the BigInt wrapper.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};
