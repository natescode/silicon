# ADR 0001 — `@generic` monomorphization: ship in 1.0 or defer to 1.1?

- **Status:** Accepted *(revised: original recommendation reversed after investigation showed @fn[T] already ships)*
- **Date:** 2026-05-26 · revised after audit + bug fix
- **Related:** `docs/v1-bootstrap-requirements.html` §2a · `docs/strata-authoring-guide.md` · `docs/hm-lite.md` · `src/types/hm-lite.test.ts` · `src/types/generic-functions.test.ts` · `src/types/typechecker.ts:checkPolymorphicCall`

## Context

The original framing of this ADR conflated two separate features:

1. **`@fn[T]` — generic functions.** A first-class `@fn` with declared type
   parameters. Inference at call sites via HM-lite. Implemented in
   `src/types/{unify,typechecker}.ts`; exercised by 33 e2e + 38 unit tests.
2. **`@generic` — a stratum-authored alternative.** A custom keyword users
   could register via Strata that captures a template, infers, mangles, and
   pushes synthesised `@fn`s — pure Strata 2.0, no compiler special case.

The audit at `v1-bootstrap-requirements.html` §2a flagged "4/4 + 5/6
skipped tests" in `src/elaborator/generic-monomorph.test.ts` and
`src/elaborator/generic-e2e.test.ts`. Those tests are about feature (2) —
the strata-authored monomorphization demo. Feature (1) is shipped and
covered.

### What investigation found

| Question | Answer |
|----------|--------|
| Does `@fn[T] id x:T := x` work end-to-end? | **Yes** — typechecks, lowers, emits valid WAT, runs under `WebAssembly.instantiate` and returns the right value per concrete instance. |
| Does the stdlib use it? | **Yes** — `src/stdlib/option.si` and `src/stdlib/result.si` ship multi-parameter generic functions (`option_unwrap_or[T]`, `result_unwrap_or[T, E]`, `result_is_ok[T, E]`). |
| Does inference handle nested generics? | **Was broken** — `&unwrap_or (&Some (&Some 42)), (&None)` failed because `checkPolymorphicCall` allocated a new `FreshGen` per call, so nested polymorphic calls recycled `?T1` names and collided. **Now fixed** by moving the `FreshGen` onto `Ctx` (single shared counter per typecheck pass). |
| Are the "9 skipped tests" the same feature? | **No.** They test the strata-authored `@generic` recipe (a capability proof for Strata 2.0), not user-written generic functions. |

## Decision

Adopt the **A+C** plan agreed in review:

- **A (this ADR + docs):** the user-facing generic-functions feature ships
  as `@fn[T]`. Documentation now reflects that. The `@generic` stratum
  demo is reframed as an advanced Strata-2.0 capability proof — deferred
  to v1.1 as a separate concern (see follow-up).
- **C (code):** audit `@fn[T]` end-to-end, fix gaps found, expand stdlib
  coverage. Shipped in this PR:
  - Found and fixed the nested-generic `FreshGen` collision in
    `src/types/typechecker.ts:checkPolymorphicCall`.
  - Added `src/types/generic-functions.test.ts` (16 tests, including
    full lower→emit→instantiate end-to-end runtime verification).
  - Added stdlib helpers: `option_is_some`, `option_is_none`,
    `result_is_err`.

## Options considered (revised)

### Option A — Doc-only fix *(rejected: incomplete on its own)*

Rewrite docs to match shipped reality but make no code changes. Closes
the "lying docs" gap but misses the chance to harden `@fn[T]` while
attention is on it.

### Option B — Ship the `@generic` stratum demo *(deferred to v1.1)*

Wire the missing comptime imports (`ast::clone`, `ast::patch_types`,
`type::bind_template_args`, `type::mangle_suffix`), make wildcard
`on::call_site` work, unskip the 9 tests. Result: a strata-system
capability proof, not a new user feature. Cost: ~1–2 days. **Deferred**
because it's a Strata-expressivity claim independent of "does Sigil have
generic functions" (which it does, via `@fn[T]`). Tracked as story
**G-1** in the v1.1 backlog.

### Option C — Audit and strengthen `@fn[T]` *(taken)*

What we did. Found one real bug, fixed it, extended stdlib, added an
end-to-end test file.

### Option D (original, now superseded) — Defer all of "@generic" to v1.1

Original ADR recommendation. Superseded because it conflated `@fn[T]`
(shipped) with the strata-authored `@generic` demo (deferred). The
defer applies only to the latter.

## Consequences

- **Positive — feature is now provably correct end-to-end.** Before this
  ADR, no test went through lower→emit→`instantiate` for generic code.
  `src/types/generic-functions.test.ts:Gap 3` now does — and the value
  it asserts (`pick() === 42`, `miss() === 7`) confirms the whole
  pipeline.
- **Positive — bug found and fixed.** Shared-`FreshGen` fix means nested
  generic calls and stdlib helpers like `option_is_some` on `Option[T]`
  work correctly regardless of how T is shaped (concrete, generic, or
  doubly-nested generic). Without this ADR the bug would have been a
  surprise in v1.1 when the first nontrivial generic-using stdlib code
  hit `Option[Option[T]]`.
- **Positive — stdlib usability up.** Three new helpers (`option_is_some`,
  `option_is_none`, `result_is_err`) cover the obvious gaps without
  requiring higher-order functions.
- **Negative — the `@generic` stratum demo still has 9 skipped tests.**
  Honest framing: they test Strata 2.0 expressivity, not generics. They
  move to story **G-1** with a new ADR (G-1 ADR to be drafted) when that
  work is scheduled.
- **Follow-up work:**
  - **G-1 (v1.1):** ship the `@generic` stratum demo end-to-end. Wire
    `ast::clone`, `ast::patch_types`, `type::bind_template_args`,
    `type::mangle_suffix`. Unskip the 9 tests in
    `src/elaborator/generic-monomorph.test.ts` and
    `generic-e2e.test.ts`. Requires `wit/comptime.wit` coverage script
    (ADR 0003 C-1) to land first so the comptime imports are auditable.
  - **G-2 (v1.1):** higher-order functions (function-typed params) so
    stdlib can ship `option_map`, `option_and_then`, `result_map`, etc.
    Major language addition; needs its own ADR.

## Implementation pointer

Code changes in this PR:

- `src/types/typechecker.ts` — `Ctx.fresh: FreshGen` added; constructor
  in `typecheck()` initialises it via `makeFreshGen()`;
  `checkPolymorphicCall` uses `ctx.fresh` instead of allocating its own.
- `src/types/generic-functions.test.ts` — new permanent test file
  covering 6 gap classes + stdlib-helper tests, 16 tests total.
- `src/stdlib/option.si` — `option_is_some`, `option_is_none`.
- `src/stdlib/result.si` — `result_is_err`.
