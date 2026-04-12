/**
 * Synchrony invariant on `ObservationSink` — enforced at runtime via
 * `assertSyncObservationSink` because TypeScript treats `() => Promise<void>`
 * as assignable to `() => void`.
 */

import { assertSyncObservationSink } from "../specialization";
import type { ObservationSink } from "../specialization";

const noop = () => {};

function syncSink(): ObservationSink {
  return {
    observeWrite: noop,
    observeCall: noop,
    activateScope: noop,
    deactivateScope: noop,
  };
}

describe("assertSyncObservationSink", () => {
  test("accepts a fully synchronous sink", () => {
    expect(() => assertSyncObservationSink(syncSink())).not.toThrow();
  });

  test("rejects a sink whose observeWrite is async", () => {
    const sink = syncSink();
    sink.observeWrite = async () => {};
    expect(() => assertSyncObservationSink(sink)).toThrow(/observeWrite.*synchronous/);
  });

  test("rejects a sink whose observeCall is async", () => {
    const sink = syncSink();
    sink.observeCall = async () => {};
    expect(() => assertSyncObservationSink(sink)).toThrow(/observeCall.*synchronous/);
  });

  test("rejects a sink whose activateScope is async", () => {
    const sink = syncSink();
    sink.activateScope = async () => {};
    expect(() => assertSyncObservationSink(sink)).toThrow(/activateScope.*synchronous/);
  });

  test("rejects a sink whose deactivateScope is async", () => {
    const sink = syncSink();
    sink.deactivateScope = async () => {};
    expect(() => assertSyncObservationSink(sink)).toThrow(/deactivateScope.*synchronous/);
  });

  test("rejects a sink missing a method", () => {
    const sink = syncSink() as Partial<ObservationSink>;
    delete sink.observeWrite;
    expect(() => assertSyncObservationSink(sink as ObservationSink)).toThrow(
      /observeWrite.*not a function/,
    );
  });

  // Boundary documentation: the tripwire catches `async`-declared methods
  // only. A plain function that returns a Promise by hand is out of scope.
  // This test pins the boundary so regressions that widen or narrow it
  // surface in review rather than silently.
  test("does NOT reject a sync function that returns Promise.resolve() by hand", () => {
    const sink = syncSink();
    sink.observeWrite = (() => Promise.resolve()) as unknown as ObservationSink["observeWrite"];
    expect(() => assertSyncObservationSink(sink)).not.toThrow();
  });
});
