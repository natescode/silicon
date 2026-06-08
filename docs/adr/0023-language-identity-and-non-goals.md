# ADR 0023 — Language identity & non-goals: a multi-mode systems language with ML ergonomics (not a functional language)

- **Status:** Accepted — ratifies the throughline already established across ADRs 0001, 0008, 0009, 0011, 0012, 0016–0022. Not a new decision; a *lens* for evaluating future ones.
- **Date:** 2026-06-07
- **Deciders:** NatesCode
- **Related:** ADR 0001 (generics: comptime-checked structural constraints, **no traits**) · ADR 0008 (bump allocator + arenas) · ADR 0009 (`--target=wasm-gc` managed mode) · ADR 0011 (capabilities / borrow / actor isolation — gradual) · ADR 0012 (effect/capability-driven optimization) · ADR 0016 (`@loop` desugars to `while`, no iterator objects) · ADR 0017–0019 (FFI / async / closures — 100% web/bun gate) · ADR 0020 (Odin-inspired grammar; no operator precedence) · ADR 0021 (bounded inference — the standing typeclass fork) · the Gradual Memory Management (Cone) north star

## Context

Silicon's *surface* reads ML-ish — immutable-by-default bindings (ADR 0020), sum
types with `@match`, `Option` / `Result`, and Hindley-Milner-style inference
(HM-lite + optional signatures). So a recurring question — from contributors and
from the design process itself — is *"is Silicon becoming a functional / ML
language?"* and, concretely, *individual feature forks keep re-posing it*: optional
signatures, bounded inference (ADR 0021), whether to add typeclasses, methods/UFCS,
operator precedence, purity, HKT.

Without a stated identity, each of those forks gets re-litigated from scratch, and
the language risks drifting — one reasonable-looking feature at a time — from a
systems language into an ML language. (A live example: operator precedence was
mistakenly added and shipped in v0.1.4, then reverted and v0.1.4 yanked, precisely
because there was no crisp "this is a non-goal" anchor to check against.)

This ADR records what Silicon *is*, what it is *not*, and the rule for deciding the
next fork.

## Decision

**Silicon is a multi-mode systems language with ML-flavored ergonomics.** Concretely:

> Zig-adjacent **comptime-metaprogramming systems core** + ML **data-modeling and
> inference** as *ergonomics* + a Cone-style **gradual, multi-mode memory model**,
> **WASM-first** (native via QBE). Expressiveness comes from **comptime (strata) +
> capabilities/effects — not from a rich type lattice.**

The ML features are adopted because they are cheap wins for **safe data modeling and
ergonomics**, *not* as a commitment to functional programming. Silicon takes ML's
front-end and keeps a systems back-end.

### Non-goals (deliberate — "we don't do this")

1. **Not garbage-collected by default.** Memory is explicit: bump allocator + arenas
   + `Rc[T]` (ADR 0008). GC is an *opt-in mode* (`--target=wasm-gc`, ADR 0009), per
   the Gradual Memory Management north star — never the default.
2. **Not pure / functional.** Mutation (`@mut`) and imperative control (`@loop`,
   `@defer`, `@if`) are first-class; safety of mutation comes from
   **capabilities/effects** (ADR 0011/0012), not from purity.
3. **No nominal typeclasses / traits as the polymorphism mechanism.** Generics are
   comptime-checked **structural** constraints, monomorphized via comptime
   (ADR 0001). At most a *small fixed set* of built-in bounds (`Num`/`Comparable`,
   ADR 0021) — never a general user-facing typeclass/ability system, and **no HKT**.
4. **No methods / UFCS.** Free `snake_case` functions; calls are always `f(args)`,
   never `x.f()`. (`.`/`::` are field access / namespacing only.)
5. **No operator precedence table.** Binary operators fold flat left-to-right;
   precedence is expressed with parentheses (ADR 0020). Keeps the parser trivially
   simple and bootstrappable.
6. **HM-*lite* only.** Inference is declared-polymorphism + use-site monomorphic
   back-fill, with **no let-generalization**. Inference is an *ergonomic*, not a
   guarantee engine; signatures stay meaningful at API boundaries.
7. **No mandatory borrow checker.** Safety is **arena-first**; capabilities/borrow
   (ADR 0011) are an *additive, gradual* upgrade, not a Rust-style precondition to
   compiling.
8. **No hidden allocation or hidden control flow** (Zig-aligned). Costs are visible
   at the call site.

### The decision rule (how to adjudicate the next fork)

At any fork that offers **more type-system abstraction** (typeclasses, HKT,
methods, precedence, purity, let-generalization), **default to the systems/minimal
choice** unless real, demonstrated use proves it necessary — and weigh the
**add-later-vs-remove-later asymmetry** (ADR 0001: a trait layer can be added on top
of monomorphization; a typeclass system can't be cheaply removed). **ML *ergonomics*
are welcome; ML *commitments* are resisted.**

## How Silicon differs from its neighbours

| vs. | Shares | Differs |
|---|---|---|
| **C** | low-level control, no hidden allocation, free functions | memory-safe (arenas + capabilities); sum types/`@match`/generics/inference; WASM-first; comptime metaprogramming |
| **Zig** *(closest)* | comptime as *the* lever; no hidden control-flow/alloc; structural generics (no traits); explicit, bootstrappable | sum types + pattern matching + HM-lite inference + `Option`/`Result` as core; **GC-optional multi-mode memory**; **operators/keywords as data (strata)**; capability/borrow direction; immutable-by-default; flat precedence; WASM-first |
| **Rust** | memory-safety + control goal; ADTs, pattern matching | safety is **gradual/additive** (not borrow-checked by default); **no traits** (comptime structural generics → no coherence/orphan tax); **GC-optional**; strata > macros; smaller surface |
| **OCaml** | HM inference, sum types, pattern matching, **operators dispatch on concrete type (no typeclasses)** | systems-first (manual/gradual memory, no GC); **HM-lite** (no let-gen); not functional (mutation, imperative loops, no currying/functors); comptime instead of functors; WASM-first |
| **Roc** | HM-style inference ("Roc trajectory"), tags/sum types, a *platform* concept (`--platform`), friendliness | **systems vs. functional**: Roc is pure-ish + auto-managed (Perceus) + *abilities* (typeclasses); Silicon is imperative + manual/gradual memory + no typeclasses + metaprogramming |

**Unique quadrant:** systems control *with* an optional managed mode; safety you opt
into *gradually*; a language you *extend from within* (strata) — WASM-first.

## Options considered

### Option A — Become Rust-like (mandatory borrow checker + traits)
**Rejected:** the coherence/orphan + borrow ceremony is exactly the cost Silicon
avoids; it wants gradual safety + comptime, not the trait lattice.

### Option B — Become OCaml/Roc-like (functional, GC/managed, typeclasses/abilities, purity)
**Rejected:** contradicts manual/gradual memory, mutation, and metaprogramming;
forfeits systems-level control.

### Option C — Stay strictly C/Zig-like (drop the ML ergonomics)
**Rejected:** sum types, pattern matching, and inference are *cheap* wins for safety
and modeling; declining them makes the language worse without protecting the
identity (the identity is protected by the *non-goals*, not by FP-austerity).

### Option D — Systems core + ML ergonomics + multi-mode memory + comptime *(chosen)*
The throughline already taken across the existing ADRs.

## Consequences

- **Positive:** a stated identity makes feature forks *adjudicable* (apply the
  decision rule); a genuinely distinct quadrant; ML ergonomics without GC/purity
  costs; a coherent story for "why no traits / methods / precedence."
- **Negative:** requires *ongoing discipline* — abstraction creep must be actively
  resisted; some conveniences are absent (no typeclass-based generic numerics
  without `[T]`, no HKT, no currying, less static guarantee than Rust by default);
  the ML-looking surface can set wrong expectations (users may *expect* typeclasses
  or purity).
- **Standing forks to watch:** ADR 0021 (keep `Num`/`Comparable` minimal vs.
  generalize into traits) · ADR 0011 (how far the borrow checker matures) · whether
  methods/UFCS ever land (currently a non-goal).

## Implementation pointer

A philosophy ADR — no code. It is the lens for future ADRs; reference it from
`compiler/CLAUDE.md` ("architectural direction") and the docs index so design forks
check against it.
