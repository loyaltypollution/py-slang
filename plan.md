# Specialization framework — plan

History through Phase 19 lives in `progress.md`. This file is the next-round
plan. After Phases 14-19 the lifecycle vocabulary collapsed from five named
events to two delta primitives + one orthogonal event, `View`/`SweepKind`
were deleted, and `TransformRule` is monomorphic over `Function` again.

## Current shape

```
specialization/
  program/            ← node-set, slot-table, function*, basic-block
  framework/          ← worklist, analysis, analysis-store, variant-body-clone
  analysis/           ← per-DFA passes
  transforms/         ← AST sweeps gated on analyses
  observation/        ← runtime ingress (channels, counters, bindings)
  speculation/        ← chain dispatch + assumption-body utilities
  assumption/         ← AssumptionChain + refutation algebra
  narrowing-policy/   ← param-handles, entry-guards, ParamKey
```

The two universal primitives:

- **NodeSet** — routing/dataflow key space. Analysis dispatch is keyed by
  `K extends NodeSet`; subscribers fire when an advancing write's `delta`
  intersects a declared `interest`.
- **AssumptionChain** — speculation primitive. The dispatch context for any
  analysis triple is a chain; analyses can chain-walk reads
  (`readMinimal` / `readDeepest`); refutation is the only chain-poisoning
  primitive.

The two lifecycle streams (per Phases 15-16):

- **Extent stream**: `(unit: Function, prev: NodeSet, next: NodeSet)` —
  `prev` empty = mint, both non-empty = rebuild, `next` empty = retire
  (unused today but the shape supports it). Eviction listeners gate on
  `prev.size > 0`.
- **Chain stream**: `(unit: Function, prev: AssumptionChain, next: AssumptionChain)` —
  the unit's preferred future-dispatch chain changed.

Plus one orthogonal primitive: `onRefute(unit, carrier)` — the refuted
chain's identity is preserved (consumers like memoization need it).

## Open directions

### A. Loop view

Triggered when an actual `Loop` view is wanted. The plan is *not* "introduce
generic Loop machinery." The plan is to answer the three questions:

1. **Materialized how?** — likely from a function's CFG, alongside the block
   apparatus.
2. **Consumed how?** — `loopContaining(nodeId)`? `loopsOf(function)`? Or just
   direct reference?
3. **Invalidated how?** — recomputed on owning function rebuild (likely)? Or
   independently dirtyable (would make Loop a root scheduling unit, not a
   subregion)?

If Loop ends up subordinate (Case A in the older draft), no framework surgery
is needed — Loop is a NodeSet with `unit: Function` ownership, computed by the
CFG apparatus. If Loop ends up as a root scheduling unit (Case B), then
`TransformRule` reacquires generics from two consumers (Function + Loop),
and `Worklist` grows a second extent stream.

### B. Block-level OSR / non-Function root scheduling

Same shape as Case B above, more aggressive. A `BlockManager` or
`TraceManager` would produce its own extent + chain streams; `Worklist`
would route the polymorphism via stream handles rather than monomorphic
`functionManager` references. Until there's a concrete proposal for what
the dispatch chain at block granularity looks like (today chains are
implicitly per-Function), this is speculative.

### C. Small remaining cleanups

- `Worklist.passCtx` — the `AnalysisCtx` for `ROOT_CONTEXT`. Only consumer
  outside the `ctxFor` fast path is `bump`'s counter dispatch. Listeners
  ignore the ctx. Could change `bump` to skip the ctx, drop `passCtx` as
  a public-instance shorthand. Marginal.
- `function-locator.ts` is a one-implementer interface. Justified by
  read-only narrowing for many readers; revisit only if the read surface
  needs to grow.
- `WorklistConfig.extraEntrySeeds` is policy held by the caller. If we
  ever want to push that decision into the analyses themselves, this
  would unify the registration story.

## Non-goals (reaffirmed)

- Don't introduce a `Unit` typeclass. The four-property bundle (NodeSet +
  identity + replaceable body + chain) is a description of `Function` today,
  not a contract needing a name.
- Don't reintroduce `View`. The "exclude EMPTY/ANY/singleton from transforms"
  fence is enforced at registration, not by a marker interface.
- Don't preemptively resurrect `SweepKind` / `TransformRule<V, P>`. Generics
  come back when a second root scheduling unit consumer exists.
- Don't add convenience wrappers around the two delta primitives. `onMint`,
  `onRebuild`, `onRetire`, `onSpecRev` are not coming back.
