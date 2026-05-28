---
title: Architectural Decision Records
---

# ADRs

Architectural Decision Records under `docs/adr/`. Each ADR is ~1 page
with options, recommendation, and resolution status.

| # | Title | Status |
|---|-------|--------|
| 0000 | Template | — |
| 0001 | `@generic` monomorphization scope | Accepted |
| 0002 | Legacy block translator | Accepted |
| 0003 | Comptime engine path (wasm3 for 1.0; Silicon interp v1.1) | Accepted |
| 0004 | Backend interface | Accepted |
| 0005 | No JS collections in public types | Accepted |
| 0006 | WASM emitter mixed-mode | Accepted |
| 0007 | Diagnostic renderer lockdown | Accepted |
| 0008 | Memory management — explicit arenas | Accepted |
| 0009 | WasmGC target (two-layer portability split) | Accepted |
| 0010 | Silicon grammar targets LL(1) | Accepted |

Read individual ADRs in the repo at
[`docs/adr/`](https://github.com/NatesCode/sigil/tree/main/docs/adr).
They are the canonical record of "why is X this way and what did we
consider instead." When a 1.0 design feels surprising, the ADR usually
explains the surprise.
