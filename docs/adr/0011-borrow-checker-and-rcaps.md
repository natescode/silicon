# ADR 0011 — Borrow checker design: scope hierarchy + reference capabilities + actor isolation

- **Status:** Proposed (design exploration; no implementation timeline) · **extended 2026-06-07 with the `Span` / `View` / `Slice` addendum below — that addendum is Accepted and prioritized for implementation** (the broader borrow checker remains exploratory)
- **Date:** 2026-05-28
- **Deciders:** NatesCode
- **Related:** ADR 0008 (memory management: explicit arenas) · `src/strata/control.si` (`@with_arena`, `@move_to_parent_arena`) · `src/stdlib/rc.si` · `src/stdlib/gc/rc.si` · planned object-capability system (separate ADR, not yet drafted) · planned actor-model ADR · [[silicon-no-postfix]] memory · prior art: OCaml's `local_` modes (Jane Street stack allocation), Pony's reference capabilities, Cyclone's region polymorphism, Rust's borrow checker

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
5. **Arena pressure from short-lived values.** Today every aggregate
   value goes to the bump-allocated arena, even when its lifetime is
   strictly shorter than the surrounding arena. A `Point` constructed
   and read inside a single function call still allocates against the
   arena and accumulates until arena exit. For long-running programs
   (servers, REPLs, `sgl watch`) this is the load-bearing reason
   arenas eventually fill.

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

**Build a small borrow checker on top of an explicit scope hierarchy
and the existing capability systems, not parallel to them.**
Specifically:

1. **Three nested scopes form the lifetime hierarchy.** Every value
   lives in exactly one scope, and references are implicitly
   parameterised by the scope they point into. No named lifetime
   variables (`'a`); the scopes are an enumeration, not a polymorphic
   axis. Inspired by OCaml's `local_` modes (Jane Street stack
   allocation), but **with the defaults inverted: Silicon defaults
   to the narrowest scope, opting into wider ones explicitly.**

   | Scope | Lifetime | Default? | Allocation strategy |
   |-------|----------|----------|--------------------|
   | `local` | enclosing function call | **yes — implicit** | WASM locals for scalars; shadow stack for compound types |
   | `arena` | enclosing `&@with_arena { … }` | opt-in via escape inference or `&@arena` keyword | bump allocator (today's model) |
   | `Rc` | until refcount = 0 (effectively program lifetime) | opt-in via `&Rc::new` | refcounted heap, single-threaded today |

   Scopes nest strictly: `local ⊂ arena ⊂ Rc`. A reference may flow
   outward (`local → arena → Rc`) via explicit promotion; it may not
   flow inward. The inversion (default-local vs OCaml's
   default-global) is the right call from a clean-sheet design
   because OCaml's default is a 30-year backwards-compatibility
   choice Silicon doesn't have.

2. **Four reference capabilities (rcaps), inferable end-to-end,
   orthogonal to the scope axis:**

   | Cap | Meaning | Mutable? | Sendable across actors? |
   |-----|---------|----------|-------------------------|
   | `&T` | Immutable, shared | no | no |
   | `&mut T` | Unique mutable | yes | no |
   | `&uniq T` | Unique, sendable | yes (receiver) | yes |
   | `&val T` | Deeply immutable, shareable + sendable | no | yes |

   Rcaps and scopes compose: a value has *both* a scope and a cap.
   `&mut T@local` is a mutable reference into a function-local value;
   `&val T@Rc` is an immutable shareable reference to a long-lived
   refcounted value.

3. **Four checker rules:**
   - **R1 — Scope.** A reference may not outlive its scope. Scope is
     one of `{local, arena, Rc}`; outlives is "the scope's destructor
     fires while the reference is still live."
   - **R2 — Aliasing.** Within a scope, for a given value at any
     program point: 0..n `&T` borrows XOR 0..1 `&mut T` borrows.
   - **R3 — Cap upgrade on cross-actor send.** A behaviour parameter
     declares `&uniq` or `&val`; the checker verifies the send-site
     value satisfies that cap.
   - **R4 — Escape promotion.** Moving a value to a wider scope
     (`local → arena` via `&@promote`, `arena → parent arena` via
     `&@move_to_parent_arena`, `arena → Rc` via `&Rc::new`) requires
     `&uniq` at the call site.

4. **Inference end-to-end inside function bodies for both scope and
   cap; explicit annotation only at API boundaries** (exported `@fn`,
   `@behaviour` parameters, stratum-registered handlers, anything
   crossing a stability seam). Escape analysis picks the smallest
   scope that fits — function bodies that don't return a value keep
   it local; bodies that return one promote to the caller's arena;
   bindings wrapped in `&Rc::new` go to Rc.

5. **Mode polymorphism for generics.** A `@fn id[T] x:T := x` is
   implicitly polymorphic over both `T`'s type *and* the rcap/scope
   pair. The return rcap and scope match the argument's unless the
   body explicitly demotes (read-only access) or promotes (escape).
   This rides HM-lite's existing universal-quantification machinery;
   the rcap layer is a parallel axis the inferer threads through.

6. **Compose with the (separately specified) object-capability
   system.** Ocaps gate which references *exist*; rcaps gate what you
   may *do* with the ones you have; scopes gate *how long they live*.
   Three orthogonal axes; all three apply.

7. **Single-threaded for v1; actor isolation handles concurrency
   later.** With copy-on-send semantics for `&val` payloads, the
   checker is a per-actor analysis; there is no inter-actor borrow
   graph to maintain. The scope hierarchy is per-actor — each actor
   has its own `local`/`arena`/`Rc` stack; cross-actor references are
   only ever `&uniq` (moves) or `&val` (immutable shared).

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

### Option B — Three-scope hierarchy + rcaps + four rules *(chosen)*

What it is: as described in the *Decision* section. Three nested
scopes (`local` / `arena` / `Rc`) serve as the lifetime hierarchy with
default-local; four rcaps express aliasing and sendability; four
rules constitute the entire checker.

- **Pro:** kills probably 60% of Rust's borrow-checker complexity by
  using a finite scope enumeration instead of named lifetimes — no
  `'a`, no variance, no elision rules, no NLL.
- **Pro:** default-local reflects what most values actually need.
  Sub-arena lifetime tracking (the gap vs Rust) is recovered for free
  by the `local` scope — values that don't escape never reach the
  arena. Solves the Context point #5 directly.
- **Pro:** composes naturally with the planned ocap system (orthogonal
  axes; all three apply without overlap).
- **Pro:** unstructured-actor isolation (separately decided) means the
  checker only runs *within* an actor; no inter-actor borrow graph.
- **Pro:** rcaps double as concurrency safety — `&uniq` and `&val` are
  the only cross-actor sends, and the rules are statically checked at
  behaviour boundaries.
- **Pro:** inference inside function bodies is tractable because the
  rcap lattice is finite (4 elements), the scope enumeration is finite
  (3 elements), and both rides HM-lite's existing machinery.
- **Pro:** the OCaml `local_` lineage is well-precedented. Jane
  Street's experience shows mode inference + escape analysis is
  tractable at production scale; the inversion (default-local) is
  the design move OCaml couldn't make for backwards-compat reasons.
- **Con:** WASM codegen complexity. WASM gives free locals for
  scalars; compound `local` types need shadow-stack allocation in
  linear memory. ~200–300 lines of codegen on top of what exists.
  Rust's WASM backend solves the same problem the same way.
- **Con:** the diagnostic-rendering layer for inferred-cap *and*
  inferred-scope failures is the hard part — explaining "we inferred
  `&mut@local` here, conflicts with the escape to `arena` on line N"
  without explicit annotations to point at. Probably ~3× the
  line-count of the checker proper.
- **Con:** inferred scope/cap means API documentation must spell out
  the contract in prose; the type signature alone (after inference)
  doesn't tell a reader whether a parameter was `&mut@local` or
  `&val@Rc` in the body.
- **Con:** mode polymorphism for generics is an additional type-system
  feature on top of HM-lite. It rides the same machinery (universal
  quantification) but the inference flow has to thread two parallel
  axes (type + mode) through every call site.
- **Cost estimate:** ~600 lines of checker stratum + ~150 lines of
  scope/cap inference + ~300 lines of codegen (shadow stack for
  `local` compound types) + ~1500 lines of diagnostic renderer.
  Months, not years.

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
- **Con:** does not solve Context point #5 (arena pressure from
  short-lived values).
- **Con:** when concurrency lands, has no answer for data races.
- **Con:** cannot eliminate `Rc<T>` overhead even when statically
  provable.
- **Con:** the absence of a story is itself a story — adopters
  evaluating Silicon against Rust will want to know the long-term
  answer.

### Option F — OCaml-style: default-global with opt-in `local`

What it is: import OCaml's Jane Street mode system as-is. Two modes
(`global` / `local`); default is `global` (today's behavior — every
value goes to the arena); `local` opts into stack allocation when
the user adds the keyword. Rcaps and rules layered on top.

- **Pro:** less disruption to today's mental model — existing v1.0
  programs read identically; locality is a per-binding optimization
  the user opts into.
- **Pro:** the mode inversion is the *only* difference from Option B;
  everything else is identical.
- **Con:** the wrong default for a clean-sheet language. OCaml chose
  global-by-default because 30 years of OCaml code assumes it.
  Silicon has no such constraint. The default should reflect what
  values actually need, which is the narrowest scope.
- **Con:** "stack-allocated" reads as an optimisation hint rather
  than a structural property; users will under-use it and arenas
  will fill faster than they should.
- **Con:** doesn't solve Context point #5 by default. Most programs
  would still allocate everything to the arena and people would have
  to know to write `local_` everywhere to get the benefit. The
  Pareto-fail mode (forgetting `local_`) is silent arena pressure.

## Consequences

### Positive

- **The borrow checker is small.** ~600 lines of checker stratum +
  ~150 lines of scope/cap inference + ~300 lines of WASM codegen
  (shadow stack) + ~1500 lines of diagnostics. Implementable as a
  stratum-registered elaboration pass over the typed AST; no
  compiler-core surgery.
- **No lifetime annotations on function signatures.** The #1 cited
  Rust UX hazard is structurally absent. Replaced by a finite
  three-element scope enumeration the inferer threads automatically.
- **Default-local is faster in the common case.** Most aggregate
  values don't escape their function; allocating them to the
  function frame instead of the arena means programs run longer
  between arena traps. Directly addresses Context point #5.
- **Sub-arena lifetime tracking is recovered for free.** The gap vs
  Rust ("can't statically reclaim value X before value Y in the same
  arena") is closed by the `local` scope — values that don't escape
  never reach the arena to begin with.
- **Memory safety + data-race freedom from one type system.** Rcaps
  + actor isolation are the same machinery, not parallel proofs.
- **Ergonomic parity with GC'd languages for the common case.**
  Inference end-to-end inside function bodies means most code reads
  like TypeScript/Roc with annotations only at API seams.
- **Composes with the planned ocap system without overlap.** Three
  orthogonal axes (ocap × rcap × scope); each gates a different
  question; the design discipline is clean.
- **Strictly stronger than v1.0 today** for aliasing-with-mutation
  bugs, which the current language doesn't detect at all.
- **Aligns with developer intuition.** Most languages (Rust, C, C++,
  Zig) put fixed-size aggregates on the stack by default and
  dynamic types on the heap. Silicon's three-scope model is the
  same intuition made explicit, with arenas as the middle layer.

### Negative

- **WASM codegen gets more complex.** Compound `local` types need
  shadow-stack allocation in linear memory — a stack pointer maintained
  in a global, bump-and-restore on function entry/exit, alignment
  bookkeeping. Well-precedented (Rust, AssemblyScript, Emscripten all
  do this) but not free. ~200-300 lines on top of the existing
  codegen.
- **Mode polymorphism for generics is a new HM-lite axis.** Generic
  functions become universally quantified over both type *and* mode
  (scope+cap). The inferer threads two parallel axes through every
  call site. Manageable but a real expansion of the type system.
- **Documentation burden on inferred APIs.** Type signatures after
  inference reveal neither scope nor cap; the API contract has to be
  spelled out in prose. The "honest API" pattern (annotate at the
  seam, infer in the body) needs documentation discipline to be
  legible.
- **Diagnostic-rendering complexity.** Failure messages for inferred
  rcaps + scopes must reconstruct *why* the checker inferred what it
  inferred; this is where most of the implementation effort lives.
- **`Rc<T>` cycles remain leakable.** Decision keeps `Rc<T>` interior-
  immutable, so the only cycle source is `Rc` graphs. Mitigation is
  a future cycle-detector stratum, not the borrow checker.
- **Self-referential structs become "use indices into a Vec."** Same
  as high-perf Rust patterns, but Silicon would never offer a `Pin`
  equivalent.
- **Some unknown-size generic types can't live in `local`.** A
  `@fn f[T] x:T := ...` where T is a struct of size known only at
  monomorphisation time can't easily use shadow-stack allocation
  without per-monomorphisation codegen. Practical answer: such
  values get promoted to `arena` by default; mode polymorphism still
  picks the right scope at each instantiation site.

### Follow-up work (no story IDs yet — this is exploration)

- **Capability system ADR** — separate ADR for the object-capability
  design (sandboxing, plugin isolation). The composition story above
  assumes that ADR exists; until it does, this ADR's "compose with
  ocaps" claim is unverified.
- **Actor model ADR** — separate ADR for unstructured actors + the
  arena-as-actor-lifetime mapping. The "concurrency safety from rcaps
  + isolation" claim depends on that ADR's commitments.
- **WASM shadow-stack design** — concrete codegen plan for compound
  `local` types: stack pointer global, frame layout, alignment rules,
  interaction with the existing bump allocator. Probably 1-2 pages of
  doc + a prototype.
- **`Vec[T]` element-borrow semantics worked example** — confirm the
  `&mut` element vs `Vec` grow rule reads cleanly under inference.
  Closing thought of the design discussion: Silicon should adopt
  Rust's rule (no long-lived `&mut T` across `Vec::push`); confirm
  no counter-pattern is worth deviating.
- **Sketch the diagnostic renderer.** Three or four representative
  failure modes (aliasing conflict, escape across scope boundary,
  cross-actor cap mismatch, scope-inference contradiction) drafted as
  concrete error output, before any code is written.
- **OCaml / Pony / Rust comparison doc** — the prior-art map. OCaml's
  `local_` (defaults inverted; same single-axis idea), Pony's
  `iso`/`trn`/`val`/`ref`/`box`/`tag` (six rcaps collapsed to four
  here), Rust's borrow checker (named lifetimes vs scope enum).
  Document the differences and the reasoning for each choice.
- **Mode-polymorphism + HM-lite integration sketch** — concrete proof
  that adding a parallel mode axis to HM-lite's universal
  quantification doesn't blow up the inference algorithm. Probably
  follows the Roc / Hindley-Milner-with-effects literature closely.

## Implementation pointer

None — this is a Proposed exploration ADR. There is no committed
implementation timeline. When/if a v1.y story scopes the work, this
ADR's status will move to Accepted and the implementing PR will be
linked.

## Load-bearing open questions

These need answers before any implementation work begins. They are
not blockers for the *direction* (the three-scope, four-cap,
four-rule approach is sound regardless), but they shape the
implementation.

1. **`Vec[T]` element-borrow rule.** Confirmed direction: same as
   Rust — no long-lived `&mut T` to elements across `Vec::push`.
   Pattern escapes (indices, two-phase, chunked storage) are all
   library patterns, not language features. No counter-argument
   surfaced. *Status: settled in the design discussion that produced
   this ADR.*

2. **WASM codegen for compound `local` types.** Shadow stack (one
   global stack pointer, bump-and-restore per call) vs per-field
   local promotion (decompose structs into individual WASM locals)
   vs hybrid. Rust's WASM backend uses shadow stack; AssemblyScript
   does too. *Tentative lean: shadow stack for v1 (proven, general);
   per-field promotion as an optimisation later for hot paths the
   profiler flags.*

3. **Scope inference vs explicit annotation defaults.** Today's
   decision is "default scope is `local`; inference promotes on
   escape." Alternative: "default scope is `arena` for compound
   types (preserving today's behaviour); inference demotes when
   provably contained." Affects whether v1.0 programs change
   behaviour silently when the checker lands. *Tentative lean: the
   chosen direction is right but a transition period flagging
   "this would be `local` in the future" warning is worth
   considering.*

4. **Mode polymorphism scope.** Are functions implicitly polymorphic
   over scope (every `@fn id[T] x:T := x` works for all three scopes
   without code duplication), or do users opt into mode polymorphism
   with explicit syntax? OCaml's `local_` requires the keyword;
   Roc-style implicit polymorphism is friendlier. *Tentative lean:
   implicit polymorphism; explicit annotation only at API seams.*

5. **Actor failure mode.** Pony-style "panic kills the actor,
   reclaims the arena, no supervision" vs Erlang-style "supervisor
   trees as a language affordance." Affects whether `@actor` has a
   parent parameter and whether mid-behaviour failure leaks the
   actor's arena. *Status: deferred to the actor-model ADR.*

6. **Selective receive.** Erlang lets behaviours pattern-match the
   mailbox and skip non-matching messages. Pony forbids it. Decision
   affects scheduler complexity and the type story for actor
   mailboxes. *Tentative lean: Pony's rule (in-arrival-order
   processing); selective receive is a library on top via internal
   buffering.*

7. **Final rcap set.** Committed: `&`, `&mut`, `&uniq`, `&val`.
   Pony's `trn` (unique-becoming-val) and `tag` (opaque identity)
   are deliberately excluded; both are clever and both have real
   uses, but committing them early risks teaching them as
   first-class concepts when they may not earn their keep in
   Silicon's smaller surface. *Status: open for revisit if a real
   use case appears.*

8. **Object-capability composition.** This ADR claims rcaps, scopes,
   and ocaps are three orthogonal axes that compose without conflict.
   The ocap ADR doesn't exist yet; this claim is unverified. *Status:
   open until the ocap ADR is drafted.*

## What this is NOT committing to

- Any v1.x or v1.y implementation date.
- A specific surface syntax for rcap or scope annotations beyond the
  `&` / `&mut` / `&uniq` / `&val` sketch and the `local` / `arena` /
  `Rc` scope names. Final syntax (including `&@local`, `&@arena`,
  `&@promote` keywords) shakes out at implementation time, constrained
  by LL(1) and the prefix-only rule.
- A specific actor model (separate ADR).
- A specific object-capability model (separate ADR).
- Backward compatibility with v1.0 programs. The 1.0 stability
  contract does not include a borrow checker, so adding one is an
  additive feature. Programs that compile today should continue to
  compile under the new defaults; the scope-inference rule must be
  designed to land without breaking v1.0 semantics. A transition
  period with `--warn-scope-promotion` (flagging values that would
  become `local` under the new rules but stay `arena` for compat) is
  plausible.
- A specific shadow-stack frame layout for compound `local` types.
  Shadow stack is the lean; the exact frame format follows the WASM
  ABI conversation at implementation time.
- Mode-polymorphism syntax. The implicit-polymorphism direction is
  picked; what users write at API seams (if anything) is open.

---

## `Span` / `View` / `Slice` (2026-06-07 addendum — Accepted, prioritized)

> This addendum is a **concrete, scoped decision** that rides the capability
> model above. It names the two reference capabilities everyone reaches for
> constantly so they're first-class, ergonomic surface types.
>
> **Implementation note (2026-06-07).** When the ADR 0022 string-bytes work
> landed, this `Span`/`View`/`Slice` rename was **deferred**: without the borrow
> checker there is no *enforced* difference between `View` and `Slice`, so the
> rename (current `Slice[T]` → `Span[T]`) is cosmetic churn that buys nothing
> yet. It is now **bundled with the borrow-checker effort** (where `View`/`Slice`
> gain real aliasing enforcement). Until then, byte views use the existing
> `Slice[u8]` (e.g. `str_bytes : String -> Slice[u8]`).

### Decision

Introduce one neutral region representation and two capability-named surface
types over it:

- **`Span[T]`** — the neutral `{ ptr Int, len Int }` region descriptor. Non-owning
  (a fat pointer into someone else's buffer). **This is today's `Slice[T]`,
  renamed.** It is the *representation*, not the everyday surface type.
- **`View[T]`** — a `Span[T]` carrying a **shared read** capability (`&`). Many may
  exist over the same or overlapping regions; none may mutate. ("Look through the
  window.")
- **`Slice[T]`** — a `Span[T]` carrying an **exclusive mutable** capability
  (`&mut`). At most one is live per region; obtained by **partitioning**. ("Your
  own slice of pizza.")

`View` / `Slice` are **sugar for a `Span` + one of two of the four rcaps**
(`&` / `&mut`) defined above — the *type name carries the capability*, so users
write `View[u8]` / `Slice[u8]` in signatures and **never** `&mut Span[u8]`. This
is deliberately more readable than Rust's `&[T]` / `&mut [T]`: the intent is in
the noun.

```silicon
\\ find (View[u8], u8) -> Int       \\ read-only; may alias the same bytes freely
\\ fill (Slice[u8], u8) -> Void     \\ exclusive, mutable; no aliasing
```

### Rules

1. **The capability governs the referent, not a reference-to-`Span`.** A `Span` is
   already a fat pointer (two ints), so `View` / `Slice` are **not** `&Span` — they
   are "a span *through which* you may read / exclusively-mutate the pointed-at
   memory." Spans pass **by value**; the capability rides along and constrains what
   may be done to the backing buffer. (No pointer-to-fat-pointer.)
2. **`Span` is the representation; the surface is always `View` or `Slice`.** A
   naked, capability-less `Span` is an unchecked `{ptr,len}` and is **not** a normal
   user-facing value — user code always holds it as a `View` or a `Slice`. There is
   no escape hatch that silently drops the capability.
3. **Mint vs partition — the load-bearing asymmetry.** `View`s may be minted freely
   and overlapping (`span_view(sp, a, b)` any time). `Slice`s are obtained only by
   **partitioning** a span into disjoint pieces (`span_split_at(sp, i) -> (Slice, Slice)`,
   `span_chunks(sp, n)`); the checker forbids two live `Slice`s over the same region.
   So `Span` exposes two op families: *read-subspan* (View-producing, overlap OK) and
   *split* (Slice-producing, disjoint). "Everyone gets their own" = partition, not
   arbitrary overlapping ranges. (These are free `snake_case` functions —
   Silicon has no methods.)
4. **No implicit coercion** (Silicon ethos). A `String` does not silently become a
   `View[u8]`; you call an explicit accessor (`str_bytes(s) -> View[u8]`, ADR 0022).
   The *header arithmetic* is hidden inside that accessor; the *conversion* is one
   visible token.
5. **Lifetimes reuse R1/R4.** `View` and `Slice` are borrows, so the scope (R1) and
   escape (R4) rules above already prevent either outliving its backing buffer — no
   new lifetime machinery.

The remaining two rcaps (`&uniq` / `&val`) stay available in their general form for
ownership-transfer / by-value cases; `View` / `Slice` simply name the two
capabilities reached for constantly.

### Consequences

- **Positive:** one representation + one enforcement mechanism (the cap model) — no
  parallel system that can drift; the names (`View` / `Slice`) are teachable
  (window vs pizza) and more readable than raw `&` / `&mut`; strings, `Vec`, and
  arrays all produce the same `Span` currency, so generic byte/element code works
  across them; no new lifetime machinery.
- **Negative:** a breaking **rename** of the existing `Slice[T]` → `Span[T]`
  (pre-1.0, acceptable); three names to learn (mitigated: conceptually it's "one
  `Span`, two caps"); the partition-to-mutate discipline must be taught.
- **Migration:** rename `Slice[T]` → `Span[T]`; the current bounds-checked accessor
  (`Slice::get`) becomes a `Span` / `View` accessor; add `View` / `Slice` as the
  capability'd surface types; update `slice.si` and the `Str → Slice[u8]` design
  note in `docs/reference/types.md`.

### Implementation pointer

Once landed: commit SHA / PR. Lands together with ADR 0022 (which consumes
`View[u8]` / `Slice[u8]` for `str_bytes(s)` and `StrBuilder`).
