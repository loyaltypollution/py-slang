# Verification pass — architecture-most-correct worktree

Overnight session, base HEAD `eea019a` (Round 4 retrospective). User scope:
verify the shipped state, fix doc/comment rot, no behaviour changes, no new
architecture, no trigger-gated follow-ups. Plan: `shiny-prancing-haven.md`.

## Baseline

```
yarn test → 38 suites passed, 2592 tests passed (8.4s)
```

Matches DECISIONS §Round 4 retrospective exactly. No tests skipped or
failing. Proceeded with the audit.

## Audit of DECISIONS §Round 4 claims against code

| Claim (DECISIONS source) | Result |
|---|---|
| `src/specialization/runtime/datalog/semi-naive.ts` exists | **Verified.** Present; exports `semiNaive` and `SemiNaiveResult<L>` with `{ envs, changedBlocks }` return shape per §Round 4 Phase 9-A spec. |
| `kildall.ts` deleted | **Verified.** Absent from `src/specialization/runtime/` tree. |
| `typeBlockEnvs` / `constBlockEnvs` delegate to `semiNaive` | **Verified.** `queries/block-envs.ts` imports and calls `semiNaive`; no references to `kildall`. |
| Framework survivors are `cfg.ts`, `mutable-env.ts`, `slot-table.ts`, `block-transfer.ts`, `function-unit.ts` (§Phase 6) | **Verified.** Exact five files; no resurrected primitives. |
| All 12 named queries from §Round 2 Phase A exist | **Verified.** `typeOf`, `constOf`, `optimizedAstOf`, `astAfterDeadBranch`, `astAfterConstFold`, `astAfterMemoize`, `callCountOf`, `purityOf`, `shouldMemoize`, `cfgOf`, `typeBlockEnvs`, `constBlockEnvs` — all present under `runtime/queries/`. |
| §Round 2 Phase B Lowered* queries shipped | **Verified.** `loweredAfterDeadBranch`, `loweredAfterConstFold`, `loweredAfterMemoize`, `optimizedLoweredOf`, `optimizedEnvironmentsOf` all present in `queries/lowering.ts`. |
| Queries are pure (no `.set(db, …)` inside bodies) | **Verified.** Only grep hit for `.set(db` is a string literal in an error message in `queries/cfg.ts:40` — not a live write. |
| No live references to dissolved primitives (`FactStore`, `class Worklist`, `AnalysisPass<`, `runtimeWritePass`, `affectedKeys`, `coarse:true`) | **Verified in code.** Three comment-level survivors all correctly describe the primitives as *dissolved*, not resurrected. Five additional stale comments still described `Worklist` as if alive — fixed in this pass, see next section. |
| `isAlreadyWrapped` / "fired" lattice gone | **Verified in code.** One comment reference in `pure-rewrites.ts:447` reads "no `isAlreadyWrapped` guard is needed" — correct description of absence. |

## Doc/comment fixes made this pass

Five sites where comments still described `Worklist` as the live
observation-sink implementation. All fixes are comment-only; no behaviour
change, no control-flow change, no import change.

| File:line | Before (summary) | After |
|---|---|---|
| `src/engines/svml/svml-interpreter.ts:20-23` | "`Worklist` implements this shape; standalone runs use `NULL_SINK`." | Describes the sink as always-NULL post-Phase-6; names `observeNodeWrite` / `observeScopeCall` as the live observation path. |
| `src/engines/cse/context.ts:5-8` | Same "`Worklist` implements this shape" claim. | Same correction as above. |
| `src/engines/cse/context.ts:68-72` | "JIT-capable evaluators swap in the `Worklist` for the duration of a run." | Describes `observationSink` as a legacy always-NULL shape; redirects readers to the hook pair. |
| `src/engines/cse/context.ts:76-79` | "PR-5: optional fact-store push hooks ... both paths stay live until PR-6 demolishes the legacy sink." | States PR-6 already happened; `observeNodeWrite` / `observeScopeCall` are the canonical path now. |
| `src/tests/const-analysis.test.ts:1-7` | Points readers to deleted `reactive-optimization.test.ts` "via Worklist" for end-to-end const-analysis coverage. | Redirects to `runtime/const-of.test.ts`, `runtime/block-envs.test.ts`, `runtime/lowering.test.ts`. |

### Already-clean sites

DECISIONS §Round 2 Phase A #2 named `svml-interpreter.ts:93,798` and
`cse/interpreter.ts:844` as stale-`runtimeWritePass` sites. All three are
already correct in the current tree — `runtimeWritePass` as a symbol has
zero hits anywhere, and the surrounding comments accurately describe the
Db `runtimeWrite` / `runtimeCall` Inputs. This was cleaned in commit
`584b1b7 — round 2 audit + stale-comment cleanup`; DECISIONS didn't log
a separate closure note.

## Post-edit test run

```
yarn test → 38 suites passed, 2592 tests passed (36.8s)
```

Identical suite/test count to baseline. No new failures, no skipped tests.

## DECISIONS statements found to be inaccurate (for user triage)

I did not amend `DECISIONS.md` — it is an append-only ledger and the two
items below are minor historical residue rather than active errors.
Flagged for user decision on whether to append a closure note:

1. **§"End-of-run summary (HEAD = e3fb6e1)" — §recommended next steps item 4.**
   Says `Phase 5a fallback db === undefined in svml-compiler.ts is a
   deliberate staging shim; it goes away in 5b`. That shim was removed in
   commit `e0f22a6 — drop factStore from SVMLCompiler` and §Round 2 Phase A
   #1 already noted it as doc-rot. The note is correct relative to when it
   was written; a reader skimming today might still be confused. Low-value
   fix; leave unless the ledger gets other amendments.

2. **§Round 4 Phase 9-A ("Honest framing up front").** Claims "the plan's
   stated non-goals" make semi-naive structurally identical to Kildall on
   py-slang's current surface. Verified — the evaluator loop is the same
   bottom-init, leq-gated, worklist-based least-fixpoint iteration. The
   only genuine mechanical difference shipped is the `changedBlocks`
   set-accumulation, which today is discarded at every call site. Not
   inaccurate; worth cross-referencing from §Round 4 retrospective if a
   reader picks up just one section.

## Residual gaps (out of this session's scope)

Each is trigger-gated per the plan; none fired, none touched. Repeated
from the plan verbatim so a future run doesn't have to re-derive the
list:

- **Phase 10 per-block invalidation.** Gated on: profiler showing
  per-unit `typeBlockEnvs`/`constBlockEnvs` re-runs dominate hot-path;
  new analysis needing per-block granularity for correctness;
  `changedBlocks` acquiring a downstream consumer; persistent-interpreter
  conductor. No trigger fired.
- **`purityOf` O(N) scope walk** (`queries/scope.ts:43-98`). Gated on a
  program with >50 top-level functions where cold-start dominates.
- **`optimizedAstOf` pass-through cell** (`queries/lowering.ts:134`).
  Gated on cell-pressure profile.
- **Missing composition test coverage** (while-loop const prop through a
  fold; nested-function and lambda purity). Gated on a bug in either path.

## Stop conditions not hit

Baseline passed, no DECISIONS claims materially wrong about code behaviour,
no edit required a surface or API change. Session completed cleanly.

## Net delta

- 4 files modified (comment-only): `svml-interpreter.ts`, `cse/context.ts`,
  `const-analysis.test.ts`.
- 1 new file: this `VERIFICATION.md`.
- 0 production-code or test-assertion changes.
- 1 commit to land on `worktree-architecture-most-correct`.
