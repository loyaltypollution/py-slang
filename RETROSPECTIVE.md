# Retrospective — architecture-most-correct

Post-mortem on the two overnight rounds that shipped the Salsa-style
Input/Query/Db rearchitecture. Three subagent perspectives were
consulted independently; this document synthesizes them. Original
reports live in the Round 2 Phase E agent transcripts.

## What held up

**The shipped ordering.** Runtime-first → Inputs → analyses as queries →
lowering queries → consumer migration → framework dissolution kept HEAD
test-green at every phase except the single Phase 6 "collapse commit"
(which itself was green at the before/after boundaries). The two
alternatives considered — *bottom-up dissolution* and *transforms-first*
— would either have required a multi-day red HEAD (blocking parallel
PR work on this repo) or introduced a `Db` ↔ `Pass<K,V>` bridge whose
invalidation semantics are harder than either pure system. Green-at-
every-commit is worth the ordering discipline.

**The scope of the refactor.** A "minimal" alternative — keep `Pass<K,V>`
for analyses, convert only the three transforms to lowering queries —
was considered. It cleanly dissolves the `"fired" lattice +
isAlreadyWrapped` guard (transforms become pure, cache provides
idempotence) and partially dissolves `coarse:true` on the transform
side, but leaves three of five workarounds load-bearing:
- `affectedKeys` persists for analyses because dispatch stays.
- Compound `{outEnv, nodeFacts}` lattice values persist because
  per-node queries don't exist in `Pass<K,V>`.
- Side-effect writes from transfer bodies persist for the same reason.

Plus the minimal world exposes a driver-level ordering contract
("converge worklist before reading lowering queries") that has no
type-level enforcement. Any consumer that reads the lowering chain
before Kildall converged gets stale facts. The full refactor makes
this impossible by construction: pulling `astAfterDeadBranch`
demand-pulls `constOf` which demand-runs Kildall. Coherence wins.

**Per-unit DFA (vs. plan's per-block cyclic queries).** The Phase 3
deviation — modeling type/const analyses as one query per `(unit,
analysis)` returning a `ReadonlyMap<BlockId, Env>`, with Kildall
iterated inside the query body — is the correct shipped shape. The
per-block cyclic-query form the architecture plan named fails a
subtle initialization constraint (see §Phase 8 below); shipping it
would have required design work disproportionate to the precision win.

## What didn't hold up

**Phase 8 (per-block SCC cyclic queries).** The spike documented a
genuine structural mismatch between DFS-driven provisional-bottom
evaluation and Kildall's RPO-based initialization. Round 2 revisited
this and concluded path (1) alone (pre-warm all block cells to
bottom-green) is under-specified — pre-warm fixes initial conditions
but doesn't drive cross-cell iteration, which still requires the
pass-1 SCC engine plus at least five additional design decisions
(ownership of prewarm list, SCC participation scope, termination
across unread cells, dep recording for never-read blocks,
invalidation granularity within an SCC). Design spec appended to
DECISIONS.md Round 2 Phase D.

**The plan's dismissal of IncA-style Datalog.** This is the only
retrospective finding that points at a genuinely better-fitting
substrate. The plan's Steelman rejected IncA in two sentences ("a
different tradition") without pricing the fit. IncA's core
mechanic — lattice-based program analyses as Datalog rules evaluated
with semi-naive iteration — is exactly what Kildall's BFS worklist
does, with one critical difference: semi-naive evaluation initializes
all IDB facts to bottom and iterates the rule set to fixpoint, which
matches Kildall's initial conditions *structurally*. **Phase 8's
failure mode does not arise in a Datalog substrate.**

The hand-rolled Salsa-style runtime remains correct for non-DFA
queries (cfgOf, purityOf, callCountOf, shouldMemoize, lowering
chain) where demand-driven memoization with early-cutoff on the
runtime-observation hot path is genuinely load-bearing. But for the
two DFA analyses specifically, a ~300–500 LoC JS-native semi-naive
Datalog evaluator would plausibly have cost the same as the shipped
`Db` + `kildall.ts` code while eliminating Phase 8 as a concept.

**The Phase 6 hidden coupling.** The sub-phases collapsed because
`transferBlockPureType`/`transferBlockPureConst` internally
allocated a throwaway `FactStore` and used `runtimeWritePass` as an
opaque seeding key. A pre-deletion grep for `new FactStore` inside
pure helpers — a five-minute audit — would have surfaced this at
plan-writing time. The lesson is process, not architecture.

## What I'd change if restarting today

1. **Hybrid substrate.** Keep the Salsa-style `Db` for cfgOf /
   purityOf / callCountOf / shouldMemoize / lowering chain / typeOf /
   constOf (per-node projections). Replace `typeBlockEnvs` /
   `constBlockEnvs` with a JS-native semi-naive Datalog evaluator
   dedicated to the DFA layer. Interface: the DFA evaluator accepts
   an AST + lattice + transfer function and returns
   `ReadonlyMap<BlockId, Env>`; the Salsa cell is a memo wrapper
   around one call to the evaluator, invalidated on `astOf` /
   `runtimeWrite` / `environmentsOf` revision bumps. Phase 8 stops
   being a problem — per-block precision comes naturally from
   semi-naive's stratified evaluation.

2. **Pre-deletion coupling audit.** Before writing the phase plan for
   any framework dissolution, grep for instances of the primitive
   being deleted inside every pure helper that will outlive it.
   Would have caught the `transferBlockPureType` coupling in Phase 6
   and preserved the planned sub-phase granularity.

3. **Lowering queries return `LoweredUnit`, not AST, from day one.**
   Round 2 Phase B retrofitted this to close the env-resolver
   coupling in `recompileAndPatch`. The first draft should have had
   it; the retrofit cost one commit but a cleaner first design would
   have avoided the legacy `astAfterX` projection queries entirely
   (they're kept now for backward compatibility with existing
   AST-only callers).

## What I'd keep

- The Input/Query primitive split and dynamic dependency tracking.
  Four workarounds from the old framework (`affectedKeys`, `coarse`,
  compound lattices, transfer-body side effects) plus the
  `isAlreadyWrapped` transform guard all dissolved by construction.
- The lowering-query chain as AST-producing functions over a single
  IR. Structural sharing + `equals: ===` gives early cutoff for free.
- Synchronous-pull at CALL safepoints. Observability at the right
  granularity, rate-limits itself as memoize installs.
- Per-chunk Db lifetime — matches the actual evaluator shape (no
  persistent cross-chunk state exists in `src/conductor/`).

## Phase 9 proposal (not implemented)

**Hybrid Datalog/Salsa substrate for the DFA layer.** Replace the
~140-LoC `queries/block-envs.ts` + `queries/kildall.ts` pair with a
dedicated semi-naive evaluator (~300–500 LoC). Retain the Salsa `Db`
surface: `db.get(typeBlockEnvs, unitId)` still reads the unit's
block-env map. Underneath, the query body runs the Datalog evaluator
instead of the hand-rolled `kildall` function.

Expected delta:
- Phase 8 resolves structurally. Per-block invalidation becomes a
  side-effect of semi-naive's rule-level dependency tracking.
- New analyses added as rule sets (3–5 rules each) instead of
  QueryHandle + lattice + serialize + test harness.
- Risk: one new runtime component to maintain. Offset by the
  elimination of the Phase 8 SCC design debt, which DECISIONS
  Round 2 Phase D estimates at several weeks if pursued directly.

Concrete trigger condition for actually shipping this: a new analysis
lands that needs per-block correctness (not just precision) — e.g.
path-sensitive type narrowing across loop back-edges, where the
per-unit join over-widens in a way that breaks specialization
soundness. Until then, the shipped per-unit `typeBlockEnvs` is
correct and fast enough; the hybrid substrate is a deferred
improvement, not a required fix.
