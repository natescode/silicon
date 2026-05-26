# ADR 0001 — `@generic` monomorphization: ship in 1.0 or defer to 1.1?

- **Status:** Proposed
- **Date:** 2026-05-26
- **Related:** `docs/v1-bootstrap-requirements.html` §2a · `docs/strata-authoring-guide.md` §8 · `src/elaborator/generic-monomorph.test.ts` · `src/elaborator/generic-e2e.test.ts`

## Context

User-written generic functions (`@generic id[T] x:T := x;` followed by
`&id 42; &id 3.14;`) are *documented* as a 1.0 feature in
`docs/strata-authoring-guide.md` §8 — the canonical Strata pattern for
monomorphization is described in detail.

In code, they are not shipped. `src/elaborator/generic-monomorph.test.ts`
has **4 of 4 tests** marked `test.skip`; `generic-e2e.test.ts` has **5 of
6** skipped. The monomorphization stratum exists in `src/strata/modules/`
but its `on::lower` hook is a no-op. HM-lite inference works (33 e2e + 38
unit tests pass), and polymorphic *sum types* (`Option[T]`, `Result[T, E]`)
ship cleanly because they don't need monomorphization — they compile to a
single representation. Polymorphic *functions* do not.

If we port the current shape to `boot/`, the self-host gate bakes in a
non-functional surface and the boot/ test for `@generic` must also be skipped.

## Decision

**Recommendation: defer user-written `@generic` functions to v1.1.** Ship
`Option[T]` / `Result[T, E]` as the 1.0 polymorphism story (sum types only);
remove the `@generic` examples from `docs/strata-authoring-guide.md` §8;
delete the skipped test files (or convert them to `xfail` with an explicit
v1.1 link).

## Options considered

### Option A — Defer to v1.1 *(recommended)*

Cost: ~half a day of doc edits + test deletions. Removes ~30–40% of remaining
Phase 7 risk because the boot/ port no longer needs a working monomorphization
stratum.

- Pro: closes the "skipped tests are a lie" gap immediately
- Pro: `Option[T]` already covers the canonical use case (generic containers)
- Pro: gives v1.1 room to design monomorphization in Silicon, not TypeScript
- Con: someone will hit this and ask. Need clear messaging in `docs/strata.md`

### Option B — Ship it in src/ before porting

Cost: ~3 days. Implement the on::lower hook (capture template → infer at
call site → mangle name → push synthesised `@fn` → rewrite call). Unskip the
9 tests. Treat them as the acceptance gate.

- Pro: the doc stays honest with no edit
- Pro: user expectation of "Silicon has generics like Rust" survives
- Con: ships a design that's hard to revise in Silicon later
- Con: 3 days of TS work right before we delete TS

### Option C — Ship a partial form: `@generic` as a Roc-style "this might monomorphize" attribute

Cost: ~2 days. Treats `@generic` as a hint the compiler may honor or
defer-to-runtime-dispatch. Less aggressive than option B.

- Pro: gives users *something*
- Con: a partial language feature is worse than no feature
- Reject

## Consequences

- **Positive (A):** boot/ port unblocks; one less surface to keep working in
  two languages
- **Negative (A):** Strata-authoring docs lose a chapter; v1.1 design starts
  from scratch in Silicon (arguably correct)
- **Follow-up work:** Strata 2.0 v1.1 design doc; consider whether
  monomorphization wants a different surface (e.g. `@fn[T] id`)

## Implementation pointer

Pending — link the PR that removes `generic-monomorph.test.ts` /
`generic-e2e.test.ts` and updates `docs/strata-authoring-guide.md` §8.
