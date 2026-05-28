# ADR 0011 — Borrow checker design: arenas + reference capabilities + actor isolation

- **Status:** Proposed (design exploration; no implementation timeline)
- **Date:** 2026-05-28
- **Deciders:** NatesCode
- **Related:** ADR 0008 (memory management: explicit arenas) · `src/strata/control.si` (`@with_arena`, `@move_to_parent_arena`) · `src/stdlib/rc.si` · `src/stdlib/gc/rc.si` · planned object-capability system (separate ADR, not yet drafted) · [[silicon-no-postfix]] memory

## Context

Silicon ships v1.0 memory-safe within arena lifetimes — the bump
allocator never frees until arena exit (ADR 0008), so use-after-free
is structurally impossible inside an arena. `Rc<T>` (interior
immutable, single-threaded) covers shared-ownership cases. There is
no borrow checker, no aliasing analysis, no `&mut`-vs-`&` distinction
in the type system.

This is sufficient for v1.0 but does not scale to:

1. **True `free` without arena exit** — a long-lived heap with
   reclaim before the surrounding arena dies.
2. **Data-race-free concurrency** — when threads / actors land.
3. **Aliasing-with-mutation bugs** — two writers, or read-while-write,
   inside one arena.
4. **Eliminating `Rc<T>` overhead when statically provable.**

A separate planned design pillar is the **object-capability (ocap)
system for security** — sandboxed plugins, untrusted scripts,
sub-system isolation. That system gates *which references exist*; it
does not on its own constrain *what you may do with a reference you
hold*. Memory safety and concurrency safety are not within its scope.

The question this ADR addresses: **what shape should Silicon's
eventual borrow checker take, given the constraints we've already
locked in (arenas, prefix-only operators, LL(1) grammar, strata as
the language-extension mechanism, eventual unstructured actors)?**

This is a design-exploration ADR, not an implementation commitment.
The work is *extremely* low priority; v1.x and v1.y will continue to
ship without a borrow checker. The point of capturing the decision
now is to (a) prevent design drift from contradicting these
constraints in unrelated work, (b) make future-us not redo the
thinking, and (c) flag the load-bearing open questions before they
get answered by accident.

## Decision

**Build a small borrow checker on top of the existing arena and
capability systems, not parallel to them.** Specifically:

1. **Arenas are the lifetime system.** Every reference is implicitly
   parameterised by the arena it points into; the borrow checker
   does not introduce named lifetime variables (`'a`). The arena
   nesting structure (already explicit in the source) IS the lifetime
   hierarchy.

2. **Four reference capabilities (rcaps), inferable end-to-end:**

   | Cap | Meaning | Local? | Sendable? | Mutable? |
   |-----|---------|--------|-----------|----------|
   | `&T` | Immutable, shared, arena-scoped | yes | no | no |
   | `&mut T` | Unique mutable, arena-scoped | yes | no | yes |
   | `&uniq T` | Unique, sendable | yes/no | yes | yes (receiver) |
   | `&val T` | Deeply immutable, shareable + sendable | yes/no | yes | no |

3. **Four checker rules:**
   - **R1 — Arena scope.** A `&T` or `&mut T` may not outlive its arena.
   - **R2 — Aliasing.** Within an arena, for a given value at any
     program point: 0..n `&T` borrows XOR 0..1 `&mut T` borrows.
   - **R3 — Cap upgrade on cross-actor send.** A behaviour parameter
     declares `&uniq` or `&val`; the checker verifies the send-site
     value satisfies that cap.
   - **R4 — State promotion.** `&move_to_parent_arena value` requires
     `&uniq` at the call site.

4. **Inference end-to-end inside function bodies; explicit annotation
   only at API boundaries** (exported `@fn`, `@behaviour` parameters,
   stratum-registered handlers, anything crossing a stability seam).

5. **Compose with the (separately specified) object-capability
   system.** Ocaps gate which references *exist*; rcaps gate what you
   may *do* with the ones you have. They are orthogonal; both apply.

6. **Single-threaded for v1; actor isolation handles concurrency
   later.** With copy-on-send semantics for `&val` payloads, the
   checker is a per-actor analysis; there is no inter-actor borrow
   graph to maintain.

## Options considered

### Option A — Rust-style: named lifetimes + traits + `Drop`

What it is: import the Rust model wholesale. Named lifetime variables
(`'a`), per-value `Drop`, `Send`/`Sync` traits, lifetime variance,
NLL/Polonius.

- **Pro:** maximally precise; per-value lifetime tracking finer than
  arena scope.
- **Pro:** mature, well-understood, decade of industry experience.
- **Con:** lifetime annotations on signatures are the #1 cited
  "fighting the borrow checker" experience for new Rust users; we'd
  be importing the worst part of Rust's UX.
- **Con:** NLL + Polonius are >100k lines of compiler complexity in
  rustc. Even a Silicon-scaled version is large.
- **Con:** `Drop` doesn't fit Silicon's arena model — arenas free
  wholesale; per-value teardown is a contradiction.
- **Con:** lifetime variance is a notorious teaching obstacle; for
  arena-bound references the question never arises.
- **Cost estimate:** ~5000 lines of stratum + ~3000 lines of
  diagnostic rendering. Years of polish.

### Option B — Arenas + rcaps + four rules *(chosen)*

What it is: as described in the *Decision* section. Arenas serve as
the lifetime system; four rcaps express aliasing and sendability;
four rules constitute the entire checker.

- **Pro:** kills probably 60% of Rust's borrow-checker complexity by
  using arenas instead of named lifetimes — no `'a`, no variance, no
  elision rules, no NLL.
- **Pro:** composes naturally with the planned ocap system (orthogonal
  axes; both apply without overlap).
- **Pro:** unstructured-actor isolation (separately decided) means the
  checker only runs *within* an actor; no inter-actor borrow graph.
- **Pro:** rcaps double as concurrency safety — `&uniq` and `&val` are
  the only cross-actor sends, and the rules are statically checked at
  behaviour boundaries.
- **Pro:** inference inside function bodies is tractable because the
  rcap lattice is finite (4 elements) and arena structure is explicit.
- **Con:** strictly weaker than Rust for sub-arena lifetime tracking.
  Cannot statically prove that value X is reclaimable before value Y
  in the same arena. For most code this doesn't matter; for libraries
  doing very fine-grained reclaim, Rust wins.
- **Con:** the diagnostic-rendering layer for inferred-cap failures is
  the hard part — explaining "we inferred `&mut` here, conflicts with
  `&` there" without explicit annotations to point at. Probably ~3×
  the line-count of the checker proper.
- **Con:** inferred caps mean API documentation must spell the cap out
  in prose; the type signature alone (after inference) doesn't tell a
  reader whether a parameter was `&` or `&mut` in the body.
- **Cost estimate:** ~600 lines of stratum (the checker) + ~1500
  lines of diagnostic renderer. Months, not years.

### Option C — Cyclone-style region polymorphism

What it is: explicit region parameters on every reference, propagated
through function signatures. Cyclone was a research C dialect that
prototyped this in the early 2000s; Rust's lifetimes are a
descendant.

- **Pro:** very expressive — multiple coexisting regions in a single
  function, region polymorphism on collections.
- **Con:** the syntactic overhead is what killed Cyclone in practice;
  every API spells out region variables, which reads heavily.
- **Con:** Silicon's arena model already provides regions; adding
  region polymorphism on top is double-counting.
- **Con:** no inferential shortcut — region parameters propagate
  through signatures even more aggressively than Rust's lifetimes.

### Option D — Linear types

What it is: every value used exactly once; mutation is "consume the
old, produce the new." Linear Haskell, Idris linearity, Granule.

- **Pro:** mathematically elegant; provides the same safety with a
  single rule.
- **Pro:** composes with effect tracking very cleanly.
- **Con:** reads strangely to mainstream developers — most operations
  produce shadowed bindings instead of in-place mutation.
- **Con:** efficient implementation requires opt-out "borrow"
  primitives, which puts you back at Rust's two-axis system anyway.
- **Con:** ecosystem expectations around in-place mutation collide
  with the model.

### Option E — Do nothing; arenas + Rc forever

What it is: ship the language without a borrow checker indefinitely;
rely on arenas for lifetime safety and Rc for shared ownership.

- **Pro:** zero compiler complexity added.
- **Pro:** memory safety within arenas is already provided.
- **Con:** does not address aliasing-with-mutation bugs (R2 above)
  inside an arena.
- **Con:** when concurrency lands, has no answer for data races.
- **Con:** cannot eliminate `Rc<T>` overhead even when statically
  provable.
- **Con:** the absence of a story is itself a story — adopters
  evaluating Silicon against Rust will want to know the long-term
  answer.

## Consequences

### Positive

- **The borrow checker is small.** ~600 lines of stratum + ~1500
  lines of diagnostics. Implementable as a stratum-registered
  elaboration pass over the typed AST; no compiler-core surgery.
- **No lifetime annotations on function signatures.** The #1 cited
  Rust UX hazard is structurally absent.
- **Memory safety + data-race freedom from one type system.** Rcaps
  + actor isolation are the same machinery, not parallel proofs.
- **Ergonomic parity with GC'd languages for the common case.**
  Inference inside function bodies means most code reads like
  TypeScript/Roc with annotations only at API seams.
- **Composes with the planned ocap system without overlap.** Both
  axes apply; neither subsumes the other; the design discipline
  ("ocaps gate which refs exist; rcaps gate what you do with them")
  is clean.
- **Strictly stronger than v1.0 today** for aliasing-with-mutation
  bugs, which the current language doesn't detect at all.

### Negative

- **Sub-arena lifetime tracking lost.** Cannot statically prove value
  X reclaimable before value Y in the same arena. For most code
  irrelevant; for some libraries Rust would catch what Silicon
  cannot.
- **Documentation burden on inferred-cap APIs.** Type signatures
  after inference don't reveal whether a parameter was mutated. API
  documentation has to spell out the contract in prose.
- **Diagnostic-rendering complexity.** Failure messages for inferred
  rcaps must reconstruct *why* the checker inferred what it inferred;
  this is where most of the implementation effort lives.
- **`Rc<T>` cycles remain leakable.** Decision keeps `Rc<T>` interior-
  immutable, so the only cycle source is `Rc` graphs. Mitigation is
  a future cycle-detector stratum, not the borrow checker.
- **Self-referential structs become "use indices into a Vec."** Same
  as high-perf Rust patterns, but Silicon would never offer a `Pin`
  equivalent.

### Follow-up work (no story IDs yet — this is exploration)

- **Capability system ADR** — separate ADR for the object-capability
  design (sandboxing, plugin isolation). The composition story above
  assumes that ADR exists; until it does, this ADR's "compose with
  ocaps" claim is unverified.
- **Actor model ADR** — separate ADR for unstructured actors + the
  arena-as-actor-lifetime mapping. The "concurrency safety from rcaps
  + isolation" claim depends on that ADR's commitments.
- **`Vec[T]` element-borrow semantics worked example** — confirm the
  `&mut` element vs `Vec` grow rule reads cleanly under inference.
  Closing thought of the design discussion: Silicon should adopt
  Rust's rule (no long-lived `&mut T` across `Vec::push`); confirm
  no counter-pattern is worth deviating.
- **Sketch the diagnostic renderer.** Two or three representative
  failure modes (aliasing conflict, escape across `move_to_parent_arena`,
  cross-actor cap mismatch) drafted as concrete error output, before
  any code is written.
- **Pony comparison** — the closest extant language is Pony.
  Document the differences (Pony has `iso`/`trn`/`val`/`ref`/`box`/
  `tag`; Silicon collapses to four) and the reasoning for collapsing.

## Implementation pointer

None — this is a Proposed exploration ADR. There is no committed
implementation timeline. When/if a v1.y story scopes the work, this
ADR's status will move to Accepted and the implementing PR will be
linked.

## Load-bearing open questions

These need answers before any implementation work begins. They are
not blockers for the *direction* (the four-rule, arena-grounded,
inferred-cap approach is sound regardless), but they shape the
implementation.

1. **`Vec[T]` element-borrow rule.** Confirmed direction: same as
   Rust — no long-lived `&mut T` to elements across `Vec::push`.
   Pattern escapes (indices, two-phase, chunked storage) are all
   library patterns, not language features. No counter-argument
   surfaced. *Status: settled in the design discussion that produced
   this ADR.*

2. **Actor failure mode.** Pony-style "panic kills the actor,
   reclaims the arena, no supervision" vs Erlang-style "supervisor
   trees as a language affordance." Affects whether `@actor` has a
   parent parameter and whether mid-behaviour failure leaks the
   actor's arena. *Status: deferred to the actor-model ADR.*

3. **Selective receive.** Erlang lets behaviours pattern-match the
   mailbox and skip non-matching messages. Pony forbids it. Decision
   affects scheduler complexity and the type story for actor
   mailboxes. *Tentative lean: Pony's rule (in-arrival-order
   processing); selective receive is a library on top via internal
   buffering.*

4. **Final rcap set.** Committed: `&`, `&mut`, `&uniq`, `&val`.
   Pony's `trn` (unique-becoming-val) and `tag` (opaque identity)
   are deliberately excluded; both are clever and both have real
   uses, but committing them early risks teaching them as
   first-class concepts when they may not earn their keep in
   Silicon's smaller surface. *Status: open for revisit if a real
   use case appears.*

5. **Object-capability composition.** This ADR claims rcaps and ocaps
   are orthogonal and compose without conflict. The ocap ADR doesn't
   exist yet; this claim is unverified. *Status: open until the ocap
   ADR is drafted.*

## What this is NOT committing to

- Any v1.x or v1.y implementation date.
- A specific syntax for rcap annotations beyond the `&`, `&mut`,
  `&uniq`, `&val` sketch. Final syntax shakes out at implementation
  time, constrained by LL(1) and the prefix-only rule.
- A specific actor model (separate ADR).
- A specific object-capability model (separate ADR).
- Backward compatibility with v1.0 programs. The 1.0 stability
  contract does not include a borrow checker, so adding one is an
  additive feature. Programs that compile today should continue to
  compile; rcaps default to `&` (immutable shared) when not
  inferred otherwise, matching today's implicit assumption.
