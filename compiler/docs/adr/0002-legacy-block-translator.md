# ADR 0002 — `legacyBlockTranslator.ts`: keep permanently or rip out?

- **Status:** Proposed
- **Date:** 2026-05-26
- **Related:** `docs/v1-bootstrap-requirements.html` §2b · `src/elaborator/legacyBlockTranslator.ts` · `src/elaborator/strata2.test.ts`

## Context

`src/elaborator/legacyBlockTranslator.ts` rewrites inline-handler
`&Compiler::*` bodies into the post-dissolution `&compiler::*` form.

It is **load-bearing today**: 17 tests in `src/elaborator/strata2.test.ts`
are marked `test.skip` with notes like "interpreter-specific patterns
(template-handle field access, scope-variable method calls) skipped pending
new-form rewrites." The Phase C engine has no interpreter fallback — when
WASM compilation of a handler fails the compiler errors out instead of
falling back, so the translator IS the interpreter path for that 17-test slice.

Two choices for the port:

1. Port the translator to Silicon. Commits us to maintaining two surface
   forms forever in the self-hosted compiler.
2. Rewrite every in-tree stratum to `&compiler::*` form. Delete the
   translator. Single surface in boot/.

## Decision

**Recommendation: rewrite all in-tree strata to `&compiler::*` form, delete
the translator, then port.** This saves ~400 LOC of Silicon we'd otherwise
need to author and maintain, and unskips 17 strata2 tests as a natural
acceptance gate.

## Options considered

### Option A — Rewrite-and-delete *(recommended)*

Cost: ~4–6 hours of mechanical rewrites across `src/strata/modules/*.si`
and `boot/strata/builtin/*.si`. The 17 skipped tests become the acceptance
gate.

- Pro: single canonical form in boot/
- Pro: deletes ~600 LOC of translator + tests
- Pro: forces the migration we'd have to do eventually anyway
- Con: byte-equal self-host gate on stage1.wasm makes this a multi-commit sequence
- Con: external strata authors using the legacy form get a hard break (no
  external strata exist today, so this is theoretical)

### Option B — Keep the translator, port it

Cost: ~1 day to port 400 LOC of translator logic to Silicon. Then forever:
two surface forms in the self-hosted compiler.

- Pro: no migration churn in `.si` files
- Con: every boot/ contributor for the rest of time has to know about both forms
- Con: ports a transitional helper as a permanent feature

### Option C — Keep the translator, document as deprecated, remove in v1.1

Cost: ~1 day (Option B) + scheduled removal work in v1.1 (also Option A).
Worst of both options.

- Reject

## Consequences

- **Positive (A):** single canonical surface; -600 LOC; 17 tests unskipped
- **Negative (A):** sequence of byte-equal-preserving commits is annoying
- **Follow-up work:** verify no external strata in the wild use the legacy
  form (likely vacuous; there are no public strata authors yet)

## Implementation pointer

Pending — link the commit sequence that rewrites the strata and deletes
`legacyBlockTranslator.ts`.
