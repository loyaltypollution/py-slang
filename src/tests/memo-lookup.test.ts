/**
 * ε2 red test: `memoLookup` miss/hit contract.
 *
 * Replaces the deleted `memoHas`/`memoGet` pair — callers now distinguish
 * miss and hit by comparing against the `MEMO_MISS` sentinel.
 */

import { clearMemoCache, memoLookup, memoPut, MEMO_MISS } from "../specialization";

describe("memoLookup", () => {
  beforeEach(clearMemoCache);

  test("miss on unknown id → MEMO_MISS", () => {
    expect(memoLookup("unknown@L1", [])).toBe(MEMO_MISS);
  });

  test("miss on known id with different args → MEMO_MISS", () => {
    memoPut("f@L1", [1], 10);
    expect(memoLookup("f@L1", [2])).toBe(MEMO_MISS);
  });

  test("hit returns stored value, not MEMO_MISS", () => {
    memoPut("f@L1", [1, 2], 42);
    const v = memoLookup("f@L1", [1, 2]);
    expect(v).toBe(42);
    expect(v).not.toBe(MEMO_MISS);
  });

  test("stored null/undefined is distinguishable from miss", () => {
    memoPut("f@L1", [], null);
    expect(memoLookup("f@L1", [])).toBe(null);
    expect(memoLookup("f@L1", [])).not.toBe(MEMO_MISS);
    memoPut("g@L1", [], undefined);
    expect(memoLookup("g@L1", [])).toBe(undefined);
    expect(memoLookup("g@L1", [])).not.toBe(MEMO_MISS);
  });
});
