// Pins that Worklist.registerTransform / sweepTransforms route through
// SweepKind, not through hardcoded FunctionManager. A synthetic SweepKind
// over a non-Function view stands in for a future Loop / Region kind: it
// owns its own mint/rebuild firing, its own dispatch chain selection, and
// its own scheduleRebuild side-effect — and the worklist's transform sweep
// drives all of it through the SweepKind interface.

import { setup } from "./harness/compile-pipelines";
import type { SweepKind } from "../../specialization/framework/sweep-kind";
import type { TransformRule } from "../../specialization/framework/analysis";
import type { View } from "../../specialization/program/views/view";
import {
  ROOT_CONTEXT,
  type AssumptionChain,
} from "../../specialization/assumption/chain";

interface SynthView extends View {
  readonly id: string;
}

function makeSynthView(id: string): SynthView {
  const ids = new Set<number>();
  return {
    id,
    contains: (n) => ids.has(n),
    size: 0,
    iterate: () => ids,
  };
}

class SynthSweepKind implements SweepKind<SynthView> {
  private readonly mintSubs: Array<(v: SynthView) => void> = [];
  private readonly rebuildSubs: Array<(v: SynthView) => void> = [];
  private readonly views: SynthView[] = [];
  readonly chains = new Map<SynthView, AssumptionChain>();
  readonly scheduledRebuilds: SynthView[] = [];

  mint(view: SynthView): void {
    this.views.push(view);
    for (const cb of this.mintSubs) cb(view);
  }
  fireRebuild(view: SynthView): void {
    for (const cb of this.rebuildSubs) cb(view);
  }
  onMint(cb: (v: SynthView) => void): void {
    this.mintSubs.push(cb);
    for (const v of this.views) cb(v);
  }
  onRebuild(cb: (v: SynthView) => void): void {
    this.rebuildSubs.push(cb);
  }
  chainFor(view: SynthView): AssumptionChain {
    return this.chains.get(view) ?? ROOT_CONTEXT;
  }
  scheduleRebuild(view: SynthView): void {
    this.scheduledRebuilds.push(view);
  }
}

describe("Worklist transform sweep is polymorphic over SweepKind", () => {
  test("registerTransform with a custom SweepKind dirties on its mint, sweeps under its chainFor, and reschedules through its scheduleRebuild", () => {
    const { worklist } = setup("x = 1\n");

    const synth = new SynthSweepKind();
    const a = makeSynthView("A");
    const b = makeSynthView("B");
    synth.mint(a);
    synth.mint(b);

    const sweepCalls: Array<{ view: SynthView; chain: AssumptionChain }> = [];
    const rule: TransformRule<SynthView, unknown> = {
      sweep: (view, chain, _program) => {
        sweepCalls.push({ view, chain });
        // Fire on the first call only; second call should not enter sweep
        // because the dirty set was cleared and no rebuild was scheduled.
        return view === a;
      },
    };

    worklist.registerTransform(rule, synth);

    // Initial mint burst should have entered both A and B in the dirty set
    // via SynthSweepKind.onMint's immediate fire-against-existing semantics.
    const fired1 = worklist.sweepTransforms();
    expect(fired1).toBe(true);
    const seen1 = new Set(sweepCalls.map(c => c.view));
    expect(seen1).toEqual(new Set([a, b]));
    expect(synth.scheduledRebuilds).toEqual([a]); // only A's sweep returned true

    // Dirty set drained — a fresh sweep with no events should be a no-op.
    sweepCalls.length = 0;
    const fired2 = worklist.sweepTransforms();
    expect(fired2).toBe(false);
    expect(sweepCalls).toEqual([]);

    // SynthSweepKind.fireRebuild re-dirties via the rebuild subscription.
    synth.fireRebuild(b);
    const fired3 = worklist.sweepTransforms();
    expect(fired3).toBe(false); // rule returns false for b
    expect(sweepCalls.map(c => c.view)).toEqual([b]);
  });

  test("custom SweepKind chainFor controls the speculation chain passed to sweep", () => {
    const { worklist } = setup("x = 1\n");

    const synth = new SynthSweepKind();
    const v = makeSynthView("V");
    synth.mint(v);

    // Construct a non-ROOT chain by hand-crafting (carrier-only — we don't
    // need any narrowing semantics to verify routing).
    const customChain: AssumptionChain = {
      ...ROOT_CONTEXT,
      depth: 1,
    } as AssumptionChain;
    synth.chains.set(v, customChain);

    let observedChain: AssumptionChain | undefined;
    const rule: TransformRule<SynthView, unknown> = {
      sweep: (_view, chain) => {
        observedChain = chain;
        return false;
      },
    };

    worklist.registerTransform(rule, synth);
    worklist.sweepTransforms();

    expect(observedChain).toBe(customChain);
  });
});
