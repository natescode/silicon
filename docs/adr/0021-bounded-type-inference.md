# ADR 0021 — Bounded type inference: body-first constraint generation + call-site refinement (the baby-typeclass bridge to traits)

- **Status:** Proposed *(DRAFT — **not prioritized**; captured during a design discussion, no code lands until Accepted)*
- **Date:** 2026-06-07
- **Deciders:** NatesCode
- **Related:** [`docs/optional-signatures-inference.md`](../optional-signatures-inference.md) (the shipped call-site inference this extends) · [`docs/hm-lite.md`](../hm-lite.md) (the `Variable` / `unify` / call-site-instantiation machinery reused here) · ADR 0001 (generics strategy — **traits deferred**; "comptime-checked structural constraints, no nominal typeclasses") · ADR 0020 (grammar redesign — bare params, signatures optional) · `compiler/src/types/typechecker.ts` (`inferUntypedParams`, `collectUntypedFns`, `checkBinaryOp`, `checkPolymorphicCall`, `programNeedsParamInference`) · `compiler/src/types/unify.ts` (`unify`, `Subst`, fresh vars) · `compiler/src/types/types.ts` (`Variable`, `isNumeric`, `isComparable`) · `compiler/src/types/errors.ts` (`missingParamType` / E0015)

## Context

Silicon makes `\\` signatures optional (ADR 0020): an unannotated `@fn` parameter's
type is **inferred**. Today inference is **call-site-driven and monomorphic** only —
it reads the concrete argument types at call sites and back-fills one concrete type,
or errors with E0015. See [`optional-signatures-inference.md`](../optional-signatures-inference.md).

Two facts box this in:

1. **Operators dispatch on concrete types; there are no typeclasses.** `+` requires
   both operands be the *same numeric type* (no implicit promotion). In the checker,
   `isNumeric(Variable)` is `false`, so `checkBinaryOp` cannot type `a + b` while
   `a`/`b` are type variables — it would reject them. This is *why* inference reads
   call sites rather than bodies.
2. **Inference ignores the body.** A parameter's type is never derived from how it is
   *used*. So functions whose body fully determines the type still fail with no call
   site:
   - `@fn greet name := { 'Hello, ' ++ name }` — `++` forces `name : String` — yet
     `E0015` with no call site.
   - `@fn inc n := { n + 1 }` — the literal `1` forces `n : Int` — yet `E0015`.

Call-site-only inference also has a structural weakness (documented in the companion
doc): it needs a *visible* call site, so uncalled / exported / **library** functions
can't be inferred, and the CLI (which inlines `@use`) disagrees with the per-file LSP
("builds but the editor flags E0015").

Call-site and body inference are **complementary** — each one's strength is the
other's gap. Body-driven is local, stable, incremental-friendly, and works for
uncalled/library code, but stalls on *under-constrained* bodies (`@fn double x := { x + x }`
is "some numeric", with no concrete anchor). Call-site-driven resolves those from
real usage, but only when a caller is visible.

## Decision

Adopt **bounded type inference**. The body generates **constraints** — including
*bounded type variables* such as `Num α` (from `+`/`-`/`*`/`/`/`%`) and
`Comparable α` (from `<`/`>`/…) — instead of erroring on type-variable operands.
Resolution then proceeds in order:

> **body-first → call-site refinement → default → `[T]`**

The body resolves everything it can (a concrete type when the body pins it, e.g.
`++` ⇒ `String` or `n + 1` ⇒ `Int`; a bounded variable when it doesn't). A call site
**refines** a bounded variable to a concrete witness (`add(1.0, 2.0)` ⇒ `Float`). With
no call site, an unresolved numeric bound **defaults** (e.g. `Num` ⇒ `Int`). A genuine
multi-type use remains a job for an explicit `[T]` generic.

Introduce only a **small fixed set of built-in bounds** (`Num`, `Comparable`,
possibly `Equatable`) — **not** a general user-facing trait/typeclass system. Per
ADR 0001 that stays deferred; this is the *minimal* mechanism that delivers the
ergonomics, and a clean on-ramp if traits are ever added.

### Worked example — `@fn add a b := { a + b }`

| Stage | Knowledge of `a` |
|---|---|
| body `a + b` | `Num α`, `α = β` (bounded variable, not yet Int/Float) |
| call `add(1.0, 2.0)` | refine `α → Float` ✓ |
| call `add(1, 2)` | refine `α → Int` ✓ |
| no call site | default `α → Int` |
| call `add("x","y")` | `α → String` ✗ — rejected: *"add needs a numeric, got String"* |

The last row is the payoff: the *combination* yields a **better diagnostic than
either source alone** — the body supplies the bound, the call site supplies the
violating witness, and the error lands at the bad call.

## Options considered

### Option A — Status quo: call-site-only, monomorphic *(shipped)*
Infer only from call-site argument types. **Pros:** already shipped; cheap; no body-checker
changes; produces concrete monomorphic types that match the model exactly. **Cons:** useless
without a visible caller (libraries, exports, demos-in-progress); non-local → CLI↔LSP
discrepancy; never uses obvious body information.

### Option B — Body-only inference (concrete-only)
Infer a parameter only when the body *fully pins* it to a concrete type (`++` ⇒ String,
`n + 1` ⇒ Int). **Pros:** local, stable, incremental-friendly, works for uncalled/library
code; great diagnostics. **Cons:** leaves under-constrained bodies (`a + b`, `double`)
unresolved — still needs a call site or default; no refinement; doesn't subsume A.

### Option C — Bounded inference: body-first + call-site refine + default *(proposed)*
Body generates constraints/bounded variables; call sites refine; defaults close the rest.
**Pros:** combines B's locality with A's refinement; best diagnostics; heals the
library/CLI↔LSP gap for body-determined functions; **mostly reuses existing machinery**
(`Variable`, `unify`, `checkPolymorphicCall`). **Cons:** introduces a bounded type variable
(a baby typeclass) into a deliberately-minimal type lattice; defaulting can surprise;
requires threading a substitution through the body checker (today it returns plain types).

### Option D — Full nominal typeclasses / traits now
General user-facing `trait`/`impl` with coherence. **Pros:** most expressive; general
dispatch. **Cons:** coherence/orphan rules are the slow, complex part (ADR 0001's reason
to defer); far more than the ergonomics need; contradicts the current strategy. Explicitly
out of scope.

## Consequences

- **Positive:**
  - Body-determined functions infer with **no call site** (`greet`, `inc` just work).
  - Ambiguous numerics (`add`, `double`) **refine** from call sites, or **default** to Int.
  - **Library functions get standalone signatures** → heals most of the CLI↔LSP
    discrepancy and the "annotate public APIs" friction for body-determined code.
  - **Precise diagnostics**: bound (from body) + witness (from call) ⇒ "needs a numeric,
    got String", located at the offending call.
  - Reuses the existing `Variable` + `unify` + call-site-instantiation path; the bound is
    a small extension, not a new type system.
  - A clean, reversible **on-ramp to traits** without committing to coherence now.
- **Negative:**
  - Adds a **bounded type variable** — a minimal typeclass — to a lattice the project
    keeps deliberately small (tension with ADR 0001's "no typeclasses").
  - **Defaulting** (`Num` ⇒ Int) is a policy choice that can surprise (a function the
    author meant for Float silently becomes Int with no call site).
  - Must reconcile with the **monomorphic-conflict** rule and explicit `@fn[T]` generics
    (when does "two numeric witnesses" become an error vs. an implicit generic?).
  - **Threading a `Subst` through the body checker** is the real cost: `checkNode` /
    `checkBinaryOp` currently return a plain `SiliconType` and discard unification state.
- **Follow-up work:**
  - Defaulting rules (numeric → Int; comparable → ?) and whether they're opt-out.
  - Interaction with ADR 0001's "ship bodies, instantiate per consumer" generics model.
  - Whether built-in bounds eventually become user-facing (the traits question).

## Implementation pointer

*(Sketch only — no code until Accepted.)*

1. **Represent a bound.** Add an optional constraint tag to `Variable` in
   `types.ts` (`{ kind:'Variable'; name; bound?: 'Num'|'Comparable'|… }`), or a
   side-table `varName → Bound`.
2. **Generate constraints in the body.** In `checkBinaryOp` (`typechecker.ts`), when an
   operand is a `Variable`, *don't* fall through to `InvalidOperator` — attach the bound
   (`Num` for arithmetic, `Comparable` for ordering), `unify` the two operands' variables,
   and return the bounded variable.
3. **Thread the substitution.** Accumulate a `Subst` (`unify.ts`) through the body check
   instead of discarding it — the larger refactor; apply it to the function signature
   when finalizing.
4. **Discharge at the call site.** `checkPolymorphicCall` already instantiates + unifies;
   extend it to verify the concrete argument satisfies the variable's bound
   (`isNumeric` / `isComparable`) and emit a precise error if not.
5. **Default & report.** An unresolved bounded variable after both passes defaults
   (`Num` ⇒ Int); a *bound-less* unresolved variable falls back to the existing E0015,
   now naming the bound.
6. **Pipeline order.** Run body-first (local; in/around `inferUntypedParams` or the
   canonical pass), then the existing call-site capture for residual variables.

Once Accepted: commit SHA / PR that lands it.
