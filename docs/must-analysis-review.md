# Must-analysis review under the current architecture

This note records what the current framework now demonstrates about
must-style analysis, and where the remaining sharp edges still are.

It is a review note, not a roadmap.

---

## 1. Short conclusion

The current framework has **two real must-style analyses**:

- `typeRequirementAnalysis` — backward + must
- `definitelyBoundAnalysis` — forward + must

That is enough to make two things true at once:

1. the framework-level four-quadrant claim is now earned by concrete in-tree
   analyses, not just by the DFA factory's type surface; and
2. must-style support still depends on analysis-specific env mechanics rather
   than on one perfectly uniform "must mode" story.

The honest current statement is:

- the DFA factory is quadrant-symmetric by construction;
- the in-tree corpus now exercises all four quadrants;
- must analyses are real production code, not speculative vocabulary;
- the tricky part is no longer "does must exist?" but "what exactly are the
  lifted-env defaults and merge semantics for this analysis?"

---

## 2. Where must semantics currently live

### A. In the `BlockDfaSpec` / DFA factory vocabulary

The framework vocabulary does include a classical distinction:

- `mergeKind: "may" | "must"`
- `direction: "forward" | "backward"`

At the type level, must analyses also require a `Lattice<L>`.
That is the right contract surface: the factory needs `top` and `meet` when the
merge discipline is intersecting rather than widening.

### B. In the lifted block-env storage algebra

The important detail is that the store writes themselves are still monotone at
the **stored-cell** level.

For block DFAs, the stored cell is not the inner semantic lattice element `L`
by itself. It is a lifted block-level value like `MutableEnv<L>` or the paired
`.facts` map.

For must DFAs, the factory makes this work by defining the stored env algebra so
that:

- `join` on the stored env uses `meetWith(...)` on slot values;
- `empty` / unwritten slot behavior comes from the lifted env representation;
- `top` is available on the inner lattice where widening-to-unconstrained is
  required.

So the framework's monotone write discipline is preserved, but it is preserved
through a specific **lifted encoding**, not through some magical store-level
understanding of must facts.

That distinction matters for review.

---

## 3. The concrete must analyses

### A. `typeRequirementAnalysis` — backward + must

`src/specialization/type-requirement-analysis/analysis.ts` propagates required
result types backward through the function body under speculative return-kind
assumptions.

Its role is:

- consume speculative return-kind assumptions from the current `Context`;
- propagate required result types backward through the function body;
- produce entry requirements that guarded compilation may use.

This is a good fit for a must-backward analysis:

- backward, because requirements flow from downstream use back to earlier
  bindings;
- must, because path joins represent obligations that must hold across all
  relevant paths.

The surrounding discipline is sound:

- runtime return observations do not become ROOT truth;
- they extend a non-ROOT speculation context;
- the analysis runs under that context;
- consumers treat the result as guard-requiring, not transform-safe.

### B. `definitelyBoundAnalysis` — forward + must

`src/specialization/definitely-bound-analysis/analysis.ts` tracks, per local
slot, whether that slot is bound on every path from function entry.

Its role is:

- seed parameter slots as bound and other locals as unbound;
- propagate binding facts forward through assignments / loop headers;
- merge with pointwise meet so any unbound predecessor keeps the slot
  unbound after a join.

This is a good fit for a must-forward analysis:

- forward, because binding status flows from earlier statements to later
  reads;
- must, because the claim is "bound on every path reaching here," not "bound
  on some path."

Its key mechanical lesson is different from `typeRequirementAnalysis`:

- sparse-env semantics are *not* enough;
- the analysis must seed every slot explicitly;
- `MutableEnv.meetWith` treats absent-slot sides as `top`, so correctness
  depends on avoiding accidental absence for the semantic "unbound" state.

Together, these two analyses show that must-style support is real in both
forward and backward directions, while still relying on analysis-specific env
representation choices.

---

## 4. Why this does not prove broad must genericity

### A. Must analyses are real, but still domain-specific

Neither in-tree must analysis should be mistaken for "generic must mode."
They are both concrete analyses with concrete consumers.

`typeRequirementAnalysis` depends on:

- `TypeLattice` being a real bounded lattice;
- the transfer being monotone in the relevant sense;
- requirements being consumed only by guarded compilation;
- speculation remaining revocable by context pruning.

`definitelyBoundAnalysis` depends on:

- a 2-point bounded lattice over `bound | unbound`;
- total seeding of every local slot at entry;
- transfer never encoding semantic `unbound` via slot absence;
- consumers treating the fact as a semantic must property of local binding,
  not as profile evidence.

So the right claim is not "must is solved once and for all"; it is "the
framework supports must analyses, and each one still has to state its env and
consumer discipline explicitly."

### B. Uniform quadrant coverage does not imply identical transfer structure

The two must analyses do not look the same internally.

- `typeRequirementAnalysis` uses a bespoke backward requirement propagator.
- `definitelyBoundAnalysis` is a much smaller forward transfer over a 2-point
  lattice.

That is not a flaw.
It is evidence that the framework's symmetry lives at the DFA-factory and
store-contract level, not at the level of one universal transfer implementation.

### C. Absent-cell and slot-absence semantics still matter a lot

In several places, the true semantic story is carried partly by the lifted env
representation rather than by one simple inner lattice story.

That is particularly visible in analyses where:

- slot absence carries meaning;
- unwritten cells differ from explicit bottom values;
- default values come from `emptyValue` or env behavior rather than from one
  universal interpretation of `bottom`.

Again, this is workable. The important review question is no longer whether a
must framework exists, but whether a given must analysis declares the right
seeding, absence, and consumer rules for its domain.

---

## 5. Soundness conditions for must analyses

There are currently two disciplined shapes for must analyses in-tree.

### A. Speculative must analysis

Profiler-driven enrichment is sound only when all of the following remain
true:

1. The enrichment is **speculative**, not semantic.
2. The enriched result is read under an explicit non-ROOT context.
3. Consumers either emit guards or otherwise preserve a deopt path.
4. No unconditional AST transform treats the enriched result as permanent.
5. Context pruning can retract the assumption chain that justified the result.

`typeRequirementAnalysis` satisfies that pattern.

### B. Semantic ROOT must analysis

A semantic must analysis is sound only when all of the following remain true:

1. its property is justified from program semantics, not runtime profile data;
2. its env/default encoding matches the intended meaning of absence vs value;
3. unconditional consumers read only ROOT results;
4. transfer preserves the must interpretation at joins.

`definitelyBoundAnalysis` satisfies that pattern through total slot seeding and
explicit `bound | unbound` values.

Any future must analysis that does not satisfy one of those disciplined shapes
should be reviewed as a separate soundness claim, not assumed sound because it
uses the same factory vocabulary.

---

## 6. Review language to use going forward

Good current phrasing:

- "The DFA framework supports all four classical quadrants, and the current
  corpus exercises all four."
- "Must support is production code in both backward and forward analyses
  (`typeRequirementAnalysis`, `definitelyBoundAnalysis`)."
- "Must analyses still need explicit review of env defaults, slot absence,
  and consumer discipline."

Avoid:

- "All analyses use the same abstraction in the same way."
- "Because the quadrants are covered, must mechanics are uniform."
- "Must support is solved once at the framework level and needs no
  analysis-specific review."

Those stronger claims are still not earned by the code.
