# ADR 0014 — Simplify value bindings to `@global` (immutable) + `@local` (mutable)

- **Status:** Accepted
- **Date:** 2026-06-05
- **Deciders:** NatesCode
- **Related:** ADR 0011 (borrow checker: scopes + rcaps — the future capability model) · `src/strata/defkinds.si` · `src/ir/lower.ts` · `src/types/typechecker.ts` · `src/codegen/qbe/lower.ts` · [[silicon-mutability-capability-model]] memory · `docs/overview.md` §4

## Context

Silicon had **three** overlapping value-binding keywords:

- `@let` — immutable (any scope).
- `@var` — mutable (top-level → mutable global, in-function → mutable local).
- `@local` — a mutable local (a near-duplicate of in-function `@var`).

This is one keyword more than the language needs: `@var` and `@local` lowered
identically inside a function, and the `@let`/`@var` split encodes mutability
that a single pair of keywords can carry. New users had to learn three keywords
and the subtle `@var`-vs-`@local` distinction.

The aspirational capability model (ADR 0011) sketches `@let` immutable-default +
a region-gated `@mut`. That is a larger, unimplemented design; this ADR is the
**shipped surface** decision for the binding keywords today.

## Decision

Collapse to **two** bindings, distinguished by mutability, and remove `@let` /
`@var`:

- **`@global`** — an **immutable** binding (a module constant). Reassignment is
  a type error (`E0007`).
- **`@local`** — a **mutable** binding. At the top level it is a module
  variable; inside a function it is a local. Reassign with `name = expr`.

`@fn` is unchanged. Binding types are always **inferred** — a binding never
carries a `:Type` annotation; types are pinned on functions via `\\` signature
lines.

## Options considered

### Option A — `@global` immutable / `@local` mutable (chosen)

Two keywords on the mutability axis. `@global` reuses `@let`'s lowering
(immutable, `LetOrFn_lower`); `@local` reuses `@var`'s (`VarDef_lower` at top
level → mutable global, in-function → mutable local). The migration is therefore
a **behaviour-preserving rename** (`@let`→`@global`, `@var`→`@local`), so the
entire existing test corpus — including immutability/mutability assertions —
stays valid.

### Option B — keep three keywords

Status quo. Rejected: redundant `@var`/`@local`, extra concept to teach.

### Option C — `@let` immutable-default + `@mut` (ADR 0011 sketch)

The capability-model surface. Rejected for now: larger, unimplemented, and
couples the everyday binding syntax to the (still-Proposed) borrow checker. This
ADR does not preclude it — `@mut` can layer on later.

## Consequences

- **Positive:** two keywords instead of three; mutability is explicit in the
  keyword; immutable-by-intent constants get a real compile-time guarantee.
- **Negative / scoping caveat:** `@global` is **module-scoped** — it registers
  a top-level name (it reuses `@let`'s `LetOrFn_lower`, a nullary definition).
  So `@global` is a **top-level-only** construct: written inside a function it
  hoists to module scope and the local reference fails at codegen. **Inside a
  function the only binding is `@local`** (mutable). Consequences: there is no
  *immutable local* (use `@local`; it simply won't be reassigned) and no
  *keyword-distinguished mutable global* (mutable module state is a top-level
  `@local`). Both gaps are deferred to the future capability model. A follow-up
  should make an in-function `@global` a clean front-end error instead of a
  codegen failure.
- **Follow-up work:** when ADR 0011 lands, reconcile `@mut`/region capabilities
  with this surface.

## Implementation pointer

Landed 2026-06-05 (commit `acd934c`). Keywords registered in
`src/strata/defkinds.si`; immutability enforced in `src/types/typechecker.ts`
(the `immutable`/`mutable` sets); top-level-vs-in-function dispatch in
`src/ir/lower.ts`. The whole corpus (stdlib, strata, examples, playground, docs,
tests) was migrated by the behaviour-preserving rename.
