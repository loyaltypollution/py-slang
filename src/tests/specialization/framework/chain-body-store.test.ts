// Chain-owned body storage: lazy fork, ancestor inheritance, ROOT fallback.

import { StmtNS } from "../../../ast-types";
import {
  bodyFor,
  forkBodyAt,
  hasForkedBodyAt,
  clearUnitBodies,
} from "../../../specialization/framework/chain-body-store";
import { extendContext, ROOT_CONTEXT } from "../../../specialization/framework/context";
import type { AssumptionHandle } from "../../../specialization/framework/analysis";
import type { Unit } from "../../../specialization/framework/function-unit";

const synthHandle: AssumptionHandle<number, number> = {
  id: Symbol("synthNarrowing"),
  debugName: "synthNarrowing",
  eq: (a, b) => a === b,
};

function makeStub(body: StmtNS.Stmt[]): Unit {
  // A minimal Unit stub sufficient for body-store tests. Other Unit
  // fields aren't touched by the store.
  return { body } as unknown as Unit;
}

describe("chain-body-store", () => {
  test("bodyFor at ROOT returns unit.body", () => {
    const body: StmtNS.Stmt[] = [];
    const unit = makeStub(body);
    expect(bodyFor(unit, ROOT_CONTEXT)).toBe(body);
  });

  test("bodyFor at non-ROOT with no forks walks up to ROOT", () => {
    const body: StmtNS.Stmt[] = [];
    const unit = makeStub(body);
    const ctx = extendContext(ROOT_CONTEXT, synthHandle, 1, 42);
    expect(bodyFor(unit, ctx)).toBe(body);
    expect(hasForkedBodyAt(unit, ctx)).toBe(false);
  });

  test("forkBodyAt materializes a deep clone", () => {
    const body: StmtNS.Stmt[] = [];
    const unit = makeStub(body);
    const ctx = extendContext(ROOT_CONTEXT, synthHandle, 1, 42);
    const fork = forkBodyAt(unit, ctx);
    expect(fork).not.toBe(body);
    expect(hasForkedBodyAt(unit, ctx)).toBe(true);
    // bodyFor now sees the fork at ctx; ROOT still sees the canonical body.
    expect(bodyFor(unit, ctx)).toBe(fork);
    expect(bodyFor(unit, ROOT_CONTEXT)).toBe(body);
  });

  test("forkBodyAt is idempotent", () => {
    const unit = makeStub([]);
    const ctx = extendContext(ROOT_CONTEXT, synthHandle, 1, 42);
    const fork1 = forkBodyAt(unit, ctx);
    const fork2 = forkBodyAt(unit, ctx);
    expect(fork2).toBe(fork1);
  });

  test("descendant of a forked context inherits the fork via ancestor walk", () => {
    const unit = makeStub([]);
    const parentCtx = extendContext(ROOT_CONTEXT, synthHandle, 1, 42);
    const childCtx = extendContext(parentCtx, synthHandle, 2, 99);
    const parentFork = forkBodyAt(unit, parentCtx);
    // childCtx has no fork of its own; bodyFor walks up and finds parent's.
    expect(hasForkedBodyAt(unit, childCtx)).toBe(false);
    expect(bodyFor(unit, childCtx)).toBe(parentFork);
  });

  test("child fork shadows parent fork at that branch", () => {
    const unit = makeStub([]);
    const parentCtx = extendContext(ROOT_CONTEXT, synthHandle, 1, 42);
    const childCtx = extendContext(parentCtx, synthHandle, 2, 99);
    const parentFork = forkBodyAt(unit, parentCtx);
    const childFork = forkBodyAt(unit, childCtx);
    expect(childFork).not.toBe(parentFork);
    expect(bodyFor(unit, childCtx)).toBe(childFork);
    expect(bodyFor(unit, parentCtx)).toBe(parentFork);
  });

  test("clearUnitBodies drops every fork", () => {
    const unit = makeStub([]);
    const ctx = extendContext(ROOT_CONTEXT, synthHandle, 1, 42);
    forkBodyAt(unit, ctx);
    expect(hasForkedBodyAt(unit, ctx)).toBe(true);
    clearUnitBodies(unit);
    expect(hasForkedBodyAt(unit, ctx)).toBe(false);
  });
});
