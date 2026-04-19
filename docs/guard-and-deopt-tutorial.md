# Guards, provenance, and deopt

This note is for evaluator authors, backend authors, and narrowing authors who
need to understand the guarded-specialization contract.

The theory first:

A speculative optimization is sound only if the system knows:

1. what assumption justified it, and
2. how to retract that assumption when the runtime disproves it.

In this framework, that contract is expressed through **guards**,
**provenance registration**, and **widening**.

---

## 1. Theory: what a guard means here

A guard is not just a runtime check.
It is a statement of dependency:

> "This emitted code path is valid only while a particular speculative fact
> lineage still holds."

That has two parts:

- runtime enforcement: detect violation;
- framework provenance: know what speculation to retract.

If you have only the first part, you can detect failure but not recover
precisely.

---

## 2. The core protocol

At emission time, a backend that uses a speculative fact must register guard
provenance:

```ts
worklist.registerGuard(guardNodeId, { narrowing, key });
```

At runtime, if that guard fails, the backend/runtime path eventually calls:

```ts
worklist.widenGuard(guardNodeId);
```

Then the worklist:

1. looks up the registered speculation fact reference;
2. computes the load-bearing assumption lineage;
3. prunes the relevant assumption(s) from the owning unit's active context;
4. fires `specContextChange`;
5. lets backend recompile/repatch logic react declaratively.

That is the model.

---

## 3. `SpecFactRef`: what provenance points to

The registered reference names:

- which narrowing dimension was involved;
- which key in that narrowing's space was guarded.

This is intentionally abstract.

The worklist does not need to know one backend's opcode shape. It needs to know
which speculation fact lineage the emitted guard protects.

---

## 4. Why provenance is mandatory

Without provenance, a deopt system has only bad choices:

- prune all speculation for the unit;
- guess which assumption mattered;
- or do nothing useful.

The current framework rejects that ambiguity.

If `widenGuard(...)` is called for a guard that was never registered, it throws.
That is good: missing provenance is a backend bug, not a case to smooth over.

Rule:

> Every guard-emitting backend must call `registerGuard(...)` at emission.

---

## 5. What `widenGuard(...)` is trying to preserve

The current widening model is lineage-precise.

That means on guard failure, the engine tries to prune only the assumption(s)
that actually shaped the guarded fact, not every speculative sibling in the
unit.

Why this matters:

- two independent observations may justify two independent guards;
- one failing should not necessarily destroy the other;
- otherwise speculative compilation becomes needlessly unstable.

This is one of the places where the narrowing contract's `lineageValue` /
`lineageEq` hooks matter.

---

## 6. The fallback when precision fails

If the worklist cannot localize the failing dependency precisely, it can widen
more aggressively.

That fallback is safer than pretending precision it does not have.

The design principle is:

> Prefer honest over-widening to unsound under-widening.

A backend/tutorial should state its deopt precision honestly.

---

## 7. `specContextChange` is the deopt lifecycle event

A deopt does not always advance ordinary facts directly.
Sometimes the important change is that the unit's active context changed.

That is why `specContextChange` exists as a lifecycle edge.

Consumers that care about active speculation context — especially backend
artifact selection — should subscribe to it.

If they don't, a guard failure can prune context without waking recompilation.

---

## 8. Retry behavior is backend-specific

The framework handles assumption pruning.
It does **not** force all backends into the same retry model.

Examples:

- SVML can catch `SpeculationViolation`, call `widenGuard`, drain, and retry.
- WASM may need entry-boundary-only guards or a different restart model.

That is why `runWithDeopt(...)` lives in `src/conductor/`, not in the generic
framework.

The backend contract is: honor widening and provenance, then implement retry in
a way your runtime model actually supports.

---

## 9. The SVML reference path

The reference implementation is:

- guard emission in `src/engines/svml/svml-compiler.ts`
- runtime violation in `src/engines/svml/errors.ts`
- retry loop in `src/conductor/jit-deopt.ts`
- provenance/widening in `src/specialization/framework/worklist.ts`

The retry loop shape is:

```ts
while (true) {
  try {
    return await execute();
  } catch (e) {
    if (!(e instanceof SpeculationViolation)) throw e;
    worklist.widenGuard(e.nodeId);
    worklist.drain();
  }
}
```

With a bounded retry budget.

That example is useful, but it is not a universal runtime model.

---

## 10. When a backend should emit a guard

A backend should emit a guard whenever it consumes a speculative fact that, if
wrong, would make the emitted code path invalid.

Typical examples:

- speculative constant-based branch/code selection;
- speculative entry-requirement hoisting;
- opcode narrowing based on speculative type/const answers.

Do not emit a guard for decisions already justified by ROOT facts alone.

---

## 11. What a transform must not do

Transforms do not participate in this protocol.

Why?

Because transforms make unconditional AST rewrites, and those are not revocable
through guard/deopt.

So if you find yourself asking how to attach a guard to an AST transform, that
is probably evidence the optimization belongs in guarded backend compilation,
not in a transform.

---

## 12. Common mistakes

### Mistake 1: speculative codegen without provenance registration

Runtime failure can happen, but the framework cannot prune precisely.

### Mistake 2: assuming every backend can retry like SVML

Different runtimes have different restart/deopt affordances.

### Mistake 3: forgetting `specContextChange` consumers

Then deopt prunes context but leaves stale compiled artifacts selected.

### Mistake 4: attaching guards to decisions already justified by ROOT facts

That adds complexity without soundness benefit.

### Mistake 5: using transforms for revocable speculative decisions

That breaks the transform boundary.

---

## 13. Practical recipe

1. Identify every speculative backend decision.
2. For each one, know which narrowing/key justified it.
3. Emit a runtime guard for that decision.
4. Call `registerGuard(...)` at emission with the correct `SpecFactRef`.
5. On violation, call or route to `widenGuard(...)`.
6. Ensure relevant backend artifact selection reacts to `specContextChange`.
7. Implement retry/fallback in a way your runtime model supports.
8. Add tests for:
   - missing provenance failure
   - precise sibling-survival widening
   - recompile/repatch after deopt
   - retry budget / non-infinite failure behavior

---

## 14. What to read in code

- `src/specialization/framework/worklist.ts`
- `src/conductor/jit-deopt.ts`
- `src/conductor/svml-jit-analysis.ts`
- `src/conductor/PySvmlJitEvaluator.ts`
- `src/conductor/PyWasmJitEvaluator.ts`
- `src/tests/specialization/runtime/speculative-narrowing.test.ts`

---

## 15. Short checklist

- [ ] Does this backend decision really depend on a speculative fact?
- [ ] Is there a matching guard?
- [ ] Is provenance registered at emission time?
- [ ] Will `widenGuard(...)` be called on failure?
- [ ] Do recompilation/repatch consumers subscribe to `specContextChange`?
- [ ] Is retry/deopt behavior honest for this runtime model?
- [ ] Am I mistakenly trying to make a transform revocable?

If any answer is "no", the speculative path is not yet complete.
