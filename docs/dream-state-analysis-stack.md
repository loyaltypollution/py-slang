# Superseded note

This document is retained only as historical design context.
Its architectural assumptions predate the current framework shape:

- `FactStore` has been removed;
- `DfaBlockFact` has been removed;
- analyses now own per-instance `AnalysisStore` storage;
- block DFAs are split into paired `.env` / `.facts` analyses;
- citizen kinds are split (`Analysis`, `AssumptionHandle`, `TransformRule`, `Narrowing`).

Use `../next-steps.md` as the authoritative planning document.
