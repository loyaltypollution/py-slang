# Sweep Reentrancy Guard — Test Observability

## What the guard currently does

`src/specialization/framework/worklist.ts`:

- `private inTransformSweep = false;` (line 213) — single boolean flag.
- Set `true` on entry to `sweepTransforms()` (line 901), reset in `finally` (line 934).
- Checked in `publish()` (line 742) and `bump()` (line 649). On violation, both throw
  a plain `new Error("[Worklist.publish] called during transform sweep. ...")` /
  `[Worklist.bump] called during transform sweep. ...`.

No typed error class. No public `inSweep` accessor. `inTransformSweep` is private.
Nothing else in `src/` references these symbols.

## What the test has to do

`src/tests/specialization/drain-invariants.test.ts:59-132`:

1. Build a synthetic `TransformRule` whose `sweep()` calls `publish`/`bump`.
2. Register it plus a `onTransformChannelPublished` wiring so it lands in the
   dirty set.
3. Fire an outer `publish` + `drain()` to actually enter `sweepTransforms`.
4. Inside the rule, `try/catch`, set `sawThrow`, regex-match
   `/transform sweep/` on `(e as Error).message`.
5. Assert `sawThrow === true`.

The ceremony breaks into two parts:
- **Entering the sweep** (steps 1-3) — unavoidable, because `sweepTransforms`
  is only reachable through `drain()` with a dirty rule.
- **Observing the throw** (step 4) — the part the hypothesis targets.

## Would a typed error / `inSweep` query simplify anything?

**Typed `SweepReentrancyError`**: would turn line 79 from
`expect((e as Error).message).toMatch(/transform sweep/)` into
`expect(e).toBeInstanceOf(SweepReentrancyError)`. That is cosmetic — same
try/catch, same `sawThrow` boolean, same number of lines. The coupling to a
message substring is weak but not a real fragility; no other call site currently
constructs an equivalent error.

The change itself would be local: one new exported class in `worklist.ts`, two
`throw` sites updated. No cross-module impact because nothing outside currently
catches these.

**Public `worklist.inSweep` getter**: does not help this test. The assertion is
"the guard fires", not "the flag flips". To observe the flag flipping you still
need to be inside a transform's `sweep()` — i.e. still need the synthetic rule
and the drain round-trip. And outside of that, no production caller has reason
to read `inSweep`: the only code that would ever be tempted to check it is code
that is already about to violate the guard, which should just... not. A getter
would be a test-only API with no production reader.

## Verdict

**Not a gap.** The real cost of the test is entering `sweepTransforms` with a
hooked rule, which is intrinsic to what is being tested — there is no shorter
path to "observe behaviour during a sweep". The `try/catch/sawThrow/regex`
ceremony on top is ~4 lines and would survive a typed error unchanged.

A typed `SweepReentrancyError` is a reasonable minor cleanup on its own merits
(stronger signature than a substring), but framing it as "collapses the test to
~3 lines" is wrong — it would save zero lines. An `inSweep` property would be a
test-only accessor with no production consumer; declining it is correct.

Referenced files:
- `/Users/loremipsum/Code/sourceacademy/py-slang/src/specialization/framework/worklist.ts` (lines 213, 648-655, 741-748, 899-937)
- `/Users/loremipsum/Code/sourceacademy/py-slang/src/tests/specialization/drain-invariants.test.ts` (lines 59-132)
