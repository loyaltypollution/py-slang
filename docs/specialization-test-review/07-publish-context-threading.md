# 07. publish's explicit context parameter — is it ceremony?

## Claim under review

`chain-reconvergence.test.ts:48–54` manually threads
`futureDispatchChainFor(unit)` into a second `publish` call to make two
observations "stack" instead of both starting from `ROOT_CONTEXT`.
Hypothesis: `publish` forcing an explicit context is a design smell.

## Production call sites

Grep across `src/` (non-test) finds exactly **two** live `worklist.publish`
call sites, both in `src/specialization/framework/runtime-analyses.ts`
inside `makeJitObservers`:

1. `observeScopeReturn` (line 218):
   ```ts
   const chain = chains[chains.length - 1];
   worklist.publish(runtimeReturnChannel, scopeId, classifyRawValue(value), chain);
   ```
   Passes the **top-of-stack chain** from a LIFO shadow maintained by the
   adapter.

2. `observeParamEntry` (line 236):
   ```ts
   const top = chains.length - 1;
   const chain = chains[top];
   chains[top] = worklist.publish(runtimeParamChannel, key, classifyRawValue(value), chain);
   ```
   Same top-of-stack chain, but **captures `publish`'s return value** and
   writes it back so the *next* param observation in this same call frame
   sees the refined/pruned chain.

The stack is seeded by `observeScopeCall` with
`worklist.futureDispatchChainFor(unit)`; `ROOT_CONTEXT` is only used as a
fallback when no enclosing scope exists.

## Is the context variety real?

**No — and yes.** Production never computes an arbitrary context. Every
`publish` uses "the chain currently live for the innermost active call
frame." That is a single, well-defined slot. In that sense the parameter
is ceremony: production never needs the freedom to publish against some
third-party context.

**But** `publish` *returns* the next chain, and `observeParamEntry` writes
it back into the slot. This is the load-bearing piece: consecutive
observations on the same frame thread the refined chain forward. The test
at lines 48–54 does exactly this threading by hand — and notably does it
suboptimally (it re-fetches `futureDispatchChainFor(unit)` for the second
publish rather than capturing the first publish's return value).
