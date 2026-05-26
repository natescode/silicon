# ADR 0003 — Comptime engine: runtime-agnostic, vendor wasm3 for 1.0

- **Status:** Proposed *(awaiting verification-gate work — see Implementation pointer)*
- **Date:** 2026-05-26 · revised after review
- **Related:** `docs/v1-bootstrap-requirements.html` §2c · `wit/comptime.wit` · `src/comptime/imports.ts` · `src/comptime/engine.ts` · v1-user-stories 3-22, 8-9

## Context

The compiler runs compiled Strata handlers *during compilation* — the
"comptime engine." This is distinct from the outer runtime that executes
`stage1.wasm` (today: wasmtime, tomorrow: whatever wraps the native binary).
The comptime engine is what's *inside* the compiler.

`src/` ships an AST-interpreter shim today (`src/comptime/engine.ts`). The
original plan was a WASM-in-WASM interpreter in Silicon; the plan then
drifted to "link wasmtime as a C library from the Phase 8 native binary."
Neither is what's shipping.

Today's `src/comptime/imports.ts` bridge surface is **incomplete**: per the
file header it lacks `ast::clone`, `ast::patch_types`, some `type::*`
primitives, and several complex AST field accessors. Handlers that need
missing imports silently fall back to the AST interpreter — but that
interpreter was deleted in Phase 1 dissolution, so they crash today.

`wit/comptime.wit` (shipped in commit `c73bc86`) now declares the full
intended surface. The question is which runtime executes compiled handlers
against that surface — and whether we couple to a *specific* runtime at all.

### Profile of the comptime engine's job

The runtime requirements are narrow:

- Runs only Sigil's own compiled handler modules (KBs each)
- One-shot execution per firing — no JIT win
- No WASI imports (every host import is sigil-specific)
- No SIMD, no atomics, no threads, no GC proposal, no exception handling
- Determinism matters: the same handler must produce the same IR
  byte-for-byte across runs and across implementations

Anything that satisfies that profile is fair game.

## Decision

**Two-part decision.**

1. **Architectural principle: WASM-runtime agnostic.** `wit/comptime.wit`
   is the contract; the runtime that executes compiled handlers against
   it is a swappable implementation detail. No Sigil source file outside
   of `src/comptime/runtime/` (TS) or `boot/comptime/runtime/` (Silicon)
   may name the runtime.

2. **v1.0 instantiation: vendor wasm3.** ~100KB single-file C interpreter
   that exactly fits the profile above. Linked into the native binary via
   a thin Silicon `@extern` shim. The TS path stays as a bootstrap fixture
   (see sunset plan below).

3. **v1.1 instantiation: replace wasm3 with a Silicon-authored interpreter.**
   Same `.wit` surface, same observable behaviour, different runtime.
   Doubles as a public dogfooding proof — "a Sigil compiler component
   that's itself a real-world systems program written in Silicon."

### TS path sunset

The TypeScript implementation in `src/comptime/imports.ts` is **bootstrap-only**:

| Milestone | TS path status |
|-----------|----------------|
| Today | Production for bun-hosted compilation; required by Phase 7 boot/ port work |
| v1.0 ship (stretch) | Deleted alongside the rest of `src/` if the bootstrap is complete |
| v1.0 ship (likely) | Frozen — accepts no new functionality, only critical fixes; lives until bootstrap completes |
| Post-1.0 | Deleted; native binary + wasm3 is the only compile path |

We *want* 1.0 to ship the complete bootstrap (TS gone). Realistic
scheduling may push that into the 1.x window. Either way, **the TS path
does not survive past 1.x maintenance.** No language design decision may
assume the TS path is permanent.

## Options considered

### Option A — Hybrid: wasmtime FFI for native, JS shim for bootstrap *(original recommendation, rejected)*

- Pro: bootstrap stays working under bun
- Con: libwasmtime is multi-MB; pulls cranelift JIT we don't use; brings WASI
  we don't use; couples boot/ to wasmtime's C ABI versioning forever
- Con: 1.0 → 1.1 swap to a Silicon interp would be a hard break

### Option B — Pure JS shim everywhere

- Reject. Native binary then depends on a JS runtime.

### Option C — Build a WASM interpreter in Silicon for v1.0

- Pro: pure Silicon, public dogfooding proof
- Pro: no transitive C dependency
- Con: ~3 weeks of focused work right before the 1.0 ship gate
- Con: self-host gate dependency on a fresh Silicon-authored interpreter
  is the highest-risk-class change we could make pre-1.0
- Defer to v1.1 instead

### Option D — Vendor wasm3 for v1.0, replace with Silicon interp in v1.1 *(recommended)*

- Pro: ~1 day of integration work for v1.0
- Pro: wasm3 is well-tested, spec-compliant for the profile we need,
  ~100KB of vendored C source — auditable in an afternoon
- Pro: clear runway to the v1.1 Silicon interpreter without 1.0 schedule risk
- Pro: WASM-runtime agnosticism is enforced from day one
- Con: vendors C code into the tree; security patches require manual updates
  (acceptable given wasm3's slow release cadence and narrow attack surface)
- Con: still two implementations (TS + wasm3) during 1.0; mitigated by
  explicit TS sunset

## Consequences

- **Positive:** runtime agnosticism becomes structural, not aspirational.
  The v1.0 → v1.1 swap is mechanical (replace one `@extern` impl) rather
  than a contract break.
- **Positive:** comptime engine binary footprint is ~100KB (wasm3) instead
  of multi-MB (wasmtime). Matters for the eventual `silk` single-binary
  distribution story.
- **Negative — determinism risk during 1.x:** the TS shim manipulates JS
  objects (Maps, closures, number coercion via `value | 0`); wasm3 executes
  spec'd WASM semantics. The same handler can produce *different IR* across
  the two paths in edge cases (Map iteration order, integer overflow,
  closure-captured handle lifetimes). Concrete mitigations:
  - Golden-output tests for every shipped handler against both runtimes
  - CI gate: every test that touches a comptime handler runs under both
    the TS shim and wasm3 (skipped under TS-deleted future)
  - The risk **disappears** at TS sunset; document this is a 1.x-window-only
    concern, not a permanent property of the design
- **Negative — vendored C source in the tree:** wasm3 lives in
  `vendor/wasm3/`. Updates are manual. We accept this because the
  alternative (network-fetched dependency at build time) breaks the
  reproducible-bootstrap property.
- **Follow-up work:**
  - **C-1 (gate for this ADR — must land before Accepted):** verification
    script `scripts/check-wit-coverage.ts` that diffs every `func` in
    `wit/comptime.wit` against the exports of `createComptimeImports()`
    in `src/comptime/imports.ts`. Runs in CI. Failing the script blocks
    the merge. Until this lands, `wit/comptime.wit` is documentation, not
    a contract.
  - **C-2 (= rescoped story 8-9):** vendor wasm3 under `vendor/wasm3/`;
    thin Silicon `@extern` shim in `boot/comptime/runtime/wasm3.si`.
    Story 8-9's original scope ("link wasmtime as a C library") is rejected
    by this ADR and replaced by C-2. v1-user-stories.html needs updating.
  - **C-3:** golden-output dual-runtime test harness (TS shim vs wasm3)
  - **C-4 (v1.1, Phase 11+):** Silicon-authored WASM interpreter replaces
    wasm3. Compiled by the v1.0 binary (whose own comptime uses wasm3);
    same self-host bootstrap shape as the compiler itself, so the v1.1
    wasm3 deletion is mechanical — swap one `@extern` impl and let the
    byte-equal gate confirm parity.
  - **W-1:** wit-bindgen integration to generate the TS host from `.wit`
  - **W-2:** sigilc plugin to generate Silicon `@extern`s from `.wit`

## Implementation pointer

Pending. **Move to Accepted only after C-1 (the verification script)
lands.** Until then, the .wit file is the *intended* contract, not the
*verified* one — and this ADR's claim that "the WIT contract is shared"
is writing a check we can't yet cash.
