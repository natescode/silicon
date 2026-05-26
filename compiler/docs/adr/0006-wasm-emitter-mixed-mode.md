# ADR 0006 — Direct WASM emitter: complete or formally retire for 1.0?

- **Status:** Proposed
- **Date:** 2026-05-26
- **Related:** `docs/v1-bootstrap-requirements.html` §3c · `docs/wasm-binary-emitter-plan.md` · `src/codegen/wasm-emitter.ts`

## Context

`src/codegen/wasm-emitter.ts` is the direct WAT→WASM-binary emitter. It does
**not** handle `IRCallIndirect`. Funcref-using modules currently route through
`compileToWat → watToWasmSync` (binaryen.js).

The result is **mixed mode**: sometimes a program compiles via the direct
emitter, sometimes it falls back to WAT-then-binaryen — and callers can't
predict which path a given program takes. boot/ would inherit the same
crutch, but boot/ doesn't have binaryen.js to fall back to without shelling
out to wabt/wasm-tools.

> Mixed mode is the worst case to inherit because callers can't predict which
> path runs.

## Decision

**Recommendation: formally retire the direct emitter for 1.0. Route everything
through WAT → binaryen for the v1.0 lifecycle. Reopen the direct path in v1.1
once the funcref work is fully scoped (~1 day per the audit, but the value
is dubious if binaryen is already available).**

`docs/wasm-binary-emitter-plan.md` updates to say "deferred to v1.1, see ADR 0006."

## Options considered

### Option A — Retire for 1.0 *(recommended)*

Cost: ~1 day. Delete `src/codegen/wasm-emitter.ts` *or* keep behind a
feature flag (`--emit=wasm-direct`) marked experimental. Update the
`Backend<T>` (ADR 0004) impl set to two: WAT and QBE. Update
`docs/wasm-binary-emitter-plan.md`.

- Pro: predictable single path. boot/ doesn't need a direct emitter
- Pro: binaryen is well-tested and small
- Con: gives up the eventual "no-binaryen" win
- Note: doesn't actually delete the file if we keep it behind a flag; just
  removes it from the default path so users can't accidentally hit it

### Option B — Complete the direct emitter

Cost: ~1 day to add funcref type/table/elem/call_indirect sections. Then
boot/ must also port the direct emitter to Silicon (additional ~3 days?).

- Pro: pure-Sigil binary emission (no binaryen)
- Pro: small native binary (no binaryen.js)
- Con: 1 day in src/ + 3 days in boot/
- Con: dilutes focus from finishing QBE backend (which IS needed for native)

### Option C — Status quo (mixed mode)

- Reject. Explicitly called out as "not an acceptable port target" in the audit.

## Consequences

- **Positive (A):** single predictable codegen path; boot/ inherits one
  backend less; QBE work gets the focus
- **Negative (A):** binaryen.js stays in the dependency tree for the v1.0
  lifecycle; the "no binaryen" win moves to v1.1
- **Follow-up work:** revisit in v1.1 once QBE native binary ships; decide
  whether the direct emitter is worth completing then

## Implementation pointer

Pending — link the PR that removes `wasm-direct` from the default Backend
set and updates `docs/wasm-binary-emitter-plan.md`.
