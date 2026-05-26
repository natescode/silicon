# ADR 0003 — Comptime engine: JS import shim vs wasmtime FFI

- **Status:** Proposed
- **Date:** 2026-05-26
- **Related:** `docs/v1-bootstrap-requirements.html` §2c · `wit/comptime.wit` · `src/comptime/imports.ts` · `src/comptime/engine.ts` · v1-user-stories 3-22, 8-9

## Context

`src/` ships an AST-interpreter shim today (`src/comptime/engine.ts`), not
the originally-planned WASM-in-WASM engine. The plan moved from "embed a
tiny wasm interpreter in stage1.wasm" to "link wasmtime as a C library from
the Phase 8 native binary."

This decision affects what boot/ needs to do **at all** — if wasmtime-as-library
is the answer, boot/ never needs a WASM-in-WASM engine and a chunk of story
3-22 evaporates.

Today's `src/comptime/imports.ts` bridge surface is **incomplete**: per the
file header it lacks `ast::clone`, `ast::patch_types`, the `type::*`
primitives (some shipped since), and several complex AST field accessors.
Handlers that need missing imports silently fall back to interpretation —
but the interpreter was deleted in Phase 1 dissolution, so they crash today.

`wit/comptime.wit` (this commit) now declares the full intended surface as
a single source of truth. The question is which runtime implements it.

## Decision

**Recommendation: commit to "comptime engine = wasmtime-as-library" for v1.0
native, and complete `src/comptime/imports.ts` to total coverage of
`wit/comptime.wit` for the bun/wasmtime hosted path used during bootstrap.**

The JS import shim is the bootstrap-only path. The shipped 1.0 self-hosted
native binary uses wasmtime FFI; the .wit file is the same for both.

## Options considered

### Option A — Hybrid: wasmtime FFI for native, JS shim for bootstrap *(recommended)*

Cost: ~1 day to complete the import shim (drive it to total `.wit` coverage).
wasmtime FFI lands in story 8-9 (already scoped). Both implementations
conform to `wit/comptime.wit`.

- Pro: bootstrap stays working under bun; native binary stays small
- Pro: WIT contract is shared — diffing the two impls is mechanical
- Pro: no WASM-in-WASM engine to ship → boot/ stays small
- Con: two implementations to keep aligned. The .wit file makes the
  alignment auditable, but it's still two implementations.

### Option B — Pure JS shim everywhere (drop wasmtime FFI)

Cost: ~0 incremental, but loses the native-binary win.

- Pro: one implementation
- Con: native binary now depends on a JS runtime → either bundle a JS
  engine into the native binary (huge) or never ship a true native binary
- Reject

### Option C — Build the WASM-in-WASM interpreter (original plan)

Cost: ~3 weeks for a minimal wasm interpreter in Silicon. Boot/ inherits it.

- Pro: pure Silicon, no FFI
- Con: 3 weeks. Reinvents wasmtime. Self-host gate dependency on a
  Silicon-authored interpreter is risky.
- Reject

## Consequences

- **Positive (A):** WIT contract closes the "three places to keep in sync"
  problem flagged in `v1-bootstrap-requirements.html` §2c
- **Negative (A):** must ship a working wasmtime-FFI binding in 8-9; native
  binary picks up a libwasmtime dependency
- **Follow-up work:**
  - W-1: wit-bindgen integration to generate the TS host from `.wit`
  - W-2: sigilc plugin to generate Silicon `@extern`s from `.wit`
  - 8-9: wasmtime FFI binding lands

## Implementation pointer

`wit/comptime.wit` lands the contract. Pending — link the PR that closes
the remaining holes in `src/comptime/imports.ts` so its coverage matches
the .wit file.
