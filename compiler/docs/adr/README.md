# Architectural Decision Records (ADRs)

This directory captures architectural decisions for the Sigil compiler in a
[lightweight MADR style](https://adr.github.io/madr/). One file per decision.
Future contributors (and future-you) should read the relevant ADRs in 5
minutes and understand *why* the code looks the way it does.

## Workflow

1. When a non-trivial architectural decision comes up, copy `0000-template.md`
   to the next number and a kebab-case slug.
2. Open it with **Status: Proposed**. Capture the context, the options
   considered, and a recommendation.
3. Discuss in the PR. Edits welcome.
4. On merge of the implementing change: bump status to **Accepted** and
   reference the implementing commit/PR in the *Consequences* section.
5. If the decision is later revisited: add a **Superseded by** link and update
   status, but do **not** delete the file.

## What counts as an ADR-worthy decision?

- Surface contracts that downstream code commits to (CaaS API shape,
  comptime ABI, IR opcodes).
- Cross-cutting refactors that touch >5 files.
- Build/release process changes.
- Anything where the *rationale* is more interesting than the change itself.

Things that are NOT ADRs: bug fixes, internal helper refactors, doc rewrites,
dependency bumps.

## Index

| # | Title | Status |
|---|-------|--------|
| [0001](0001-generic-monomorphization-scope.md) | `@fn[T]` ships; `@generic` stratum demo deferred to v1.1 | Accepted |
| [0002](0002-legacy-block-translator.md) | `legacyBlockTranslator.ts`: keep permanently or rip out? | Proposed |
| [0003](0003-comptime-engine-path.md) | Comptime engine: runtime-agnostic, vendor wasm3 for 1.0 | Proposed |
| [0004](0004-backend-interface.md) | Uniform `Backend<T>` interface for codegen targets | Proposed |
| [0005](0005-no-js-collections-in-public-types.md) | No `Map` / `WeakMap` in public CaaS surface | Proposed |
| [0006](0006-wasm-emitter-mixed-mode.md) | Direct WASM emitter: complete or formally retire for 1.0? | Proposed |
| [0007](0007-diagnostic-renderer-lockdown.md) | Lock the diagnostic pretty-renderer surface for 1.0 | Proposed |
| [0008](0008-memory-management-arenas.md) | Memory management: explicit arenas for 1.0, AllocatorABI for 1.1 | Accepted |
