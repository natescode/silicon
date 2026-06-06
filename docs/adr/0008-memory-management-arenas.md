# ADR 0008 — Memory management: explicit arenas for 1.0, AllocatorABI for 1.1

- **Status:** Accepted (2026-05-26 — `wit/allocator.wit` landed, M-1 gate met)
- **Date:** 2026-05-26
- **Related:** `wit/allocator.wit` (the ABI surface) · `src/codegen/prelude-ir.ts` (first conformer — bump allocator) · `src/codegen/std.wat` · `src/strata/control.si` (`@with_arena` + `@move_to_parent_arena`) · ADR 0003 (parallel runtime-agnosticism pattern via `wit/comptime.wit`)

## Context

Today's allocator is a bump allocator in `src/codegen/std.wat`, surfaced
through `$alloc`, `$alloc_array`, `$alloc_string`, and `$realloc` (see
`src/codegen/prelude-ir.ts:135–218`). Heap starts at offset 1024 (with
a runtime adjustment for data-segment overflow). `$realloc` abandons the
old block — there is no free list. Comment at `prelude-ir.ts:200–201`:

> permanently lost — acceptable for 1.0; a real free-list allocator is
> [future work]

Three load-bearing facts:

- **Every heap-using stdlib type depends on this allocator**: String
  (`$alloc_string`), Vec/HashMap (`$realloc`), sum-type variants
  (`$alloc`). Changing the contract is a breaking change for every
  Silicon program.
- **Works for one-shot compilations.** `sigilc one.si` runs, allocates
  forward through the heap, exits, OS reclaims. No problem.
- **Fails for anything iterative.** A `sgl watch` loop, a server, a
  REPL, a long-running test process: nothing is ever freed, the heap
  fills, the program traps.

The language's stated long-term direction is **gradually memory-managed**:
multiple allocator strategies selectable per scope, eventually
Strata-defined. v1.0 must not paint us into an allocator choice that
forecloses that — same architectural concern as ADR 0003's runtime
agnosticism for the comptime engine.

This is Silicon's founding inspiration: Jonathan Goodwin's **Gradual Memory
Management** (*A Framework for Gradual Memory Management*, 2017,
<https://jondgoodwin.com/pling/gmm.pdf>), prototyped in his language **Cone**
(<https://cone.jondgoodwin.com/>, "Memory Managed Your Way"). GMM — by explicit
analogy to gradual *typing* — lets one program pick its memory strategy on an
alias-by-alias basis, decomposing every reference into value type, lifetime,
**allocator type / region**, and **permission**. Silicon realizes the allocator
axis as two whole-program **modes** (this ADR's arenas vs ADR 0009's wasm-gc)
plus an `Rc` opt-in, and the permission axis as the rcaps of ADR 0011. Honest
scope: GMM is a research-grade working hypothesis (Cone enforces only
mutability + coercion today), so v1.0 is "switchable modes + opt-in," on a
*path* to gradual-MM-in-Goodwin's-sense, not there yet — see
[`docs/v1.0-critical-path.md`](../v1.0-critical-path.md) §1.

## Decision

Three-part decision, mirroring ADR 0003's principle/instantiation/runway shape.

**1. Architectural principle: allocator agnosticism.** A single
`wit/allocator.wit` interface defines the contract every Sigil allocator
conforms to (`alloc`, `realloc`, `free_all`, …). The compiler talks to
allocators only through that interface. Built-ins, future user
allocators, and v1.1+ GCs all implement the same WIT — same pattern as
`wit/comptime.wit` for the comptime engine.

**2. v1.0 instantiation: bump allocator + `&with_arena { ... }` + `&move_to_parent_arena value`.**

- The existing bump allocator stays as the global default. Programs that
  don't touch `&with_arena` see no behaviour change.
- New scoped construct `&with_arena { body }`:
  - Saves the current heap pointer at entry.
  - All allocations inside `body` bump from a new arena (the region
    between the saved pointer and wherever bumping reaches).
  - On scope exit, the heap pointer resets to the saved value (plus
    any promoted bytes — see below) — every other byte allocated
    during `body` is freed at once.
  - Nests stack-discipline: arenas form a LIFO stack, freeing is just
    "restore the saved pointer." No fragmentation, no metadata.
- For one-shot CLI tools (sigilc, `sgl build`): no `&with_arena`
  needed. Single global arena suffices. Zero ceremony.
- For long-running programs: wrap per-iteration work in
  `&with_arena`. Manual but predictable.

**Return-value escape: `&move_to_parent_arena value` (v1.0).** Heap-
allocated returns (`String`, value-type arrays, sum types with
all-value payloads) escape via an explicit builtin:

```silicon
&@local greeting := &with_arena {
    &@local hello := &str_concat "hi, ", name;
    # ... arbitrary work allocating scratch strings ...
    &move_to_parent_arena hello   # must be the block's tail expression
};
# `greeting` is a String allocated in the *outer* arena;
# every other byte the inner arena bumped is freed.
```

Semantics:

- `&move_to_parent_arena v` is a compile error anywhere except the tail
  position of a `&with_arena { ... }` body. (No interleaved use of the
  promoted pointer inside the same block — that would require runtime
  pointer-rewriting.) The compiler enforces this statically during IR
  lowering.
- At arena exit, the runtime helper `$arena_promote(ptr, size)`
  memcpy's the value's bytes from inside-arena to the saved-pointer
  region, then sets `heap = saved + size`. The returned pointer is the
  new (post-copy) location.
- "Size" is computed from the value's type:
  - `String` → `4 + i32.load(ptr)` (header + UTF-8 bytes)
  - `[T]` value-type array → `4 + count * sizeof(T)`
  - Sum-with-flat-payloads → pad-to-max width (already a contiguous
    block)
  - Value type (`Int`, `Float`, `Bool`, payload-free enum) → no copy,
    `&move_to_parent_arena` is a no-op (just unwind the arena)
- **Nested heap types are deferred to v1.1.** `Vec[String]`,
  `Option[Vec[Int]]`, sum types with `String`-payload variants are a
  compile error: "type `T` contains nested heap references; explicit
  promotion of nested heap is a v1.1 feature." Workaround: keep the
  outer arena wider, or restructure the data flat.

Stylistic motivation: matches Silicon's "no implicit coercion"
philosophy (cf. `&@toInt64` rather than implicit widening). The cost
of the memcpy is visible at the call site, not hidden in a return
edge.

**3. v1.1+ runway: GC and richer allocators as Strata.**

- The first v1.1 stratum experiment is a simple mark-sweep GC
  implementing `wit/allocator.wit`. Doubles as a public dogfooding
  proof: "the allocator interface is real, here's a non-trivial impl."
- Reference counting later, ownership/borrow checking much later.
- v1.1 extends `&move_to_parent_arena` to nested heap types via
  trace-and-copy (walking the value graph, recursively promoting
  reachable heap blocks, fixing up internal pointers). Lifts the
  flat-type restriction.
- v1.1 also lifts the **tail-position** restriction — once the runtime
  can rewrite in-flight pointer locals, `&move_to_parent_arena` can be
  called from anywhere in the body.

## Options considered

### Option A — Keep current bump allocator forever, no scopes

- Pro: zero work
- Con: forecloses every long-running program; "Sigil can only do CLI tools" is not 1.0
- Reject

### Option B — Automatic per-function arena (the user's first instinct)

- Pro: looks like "stack frames for heap"
- Con: return-value escape is a real problem. Either we forbid heap returns from every function (severe restriction) or we add escape analysis (substantial type-system work) or we copy returns (a tiny GC)
- Con: programs that should be fine become OOMs (deep call stacks burn memory if escape semantics are wrong)
- Reject

### Option C — Automatic per-module arena

- Pro: minimal user-visible change
- Con: equivalent to today's behavior for any program big enough to matter (a module-lifetime arena = the whole heap)
- Reject

### Option D — Explicit `&with_arena { ... }` + AllocatorABI *(recommended)*

- Pro: predictable; nesting works; no escape-analysis prerequisite
- Pro: ABI defined now means v1.1 GC drops in without breaking 1.0 programs
- Pro: ergonomically close to Zig's `arena_allocator` pattern, which is well-understood
- Con: requires users to think about arenas for long-running programs (mitigation: docs + one-shot CLIs need nothing)

### Option E — Ship a simple GC in 1.0

- Pro: most ergonomic for the user
- Con: "simple GC" is hundreds of lines of careful code touching every allocation
- Con: once a stdlib type uses the GC, removing it is a breaking change
- Con: distracts from the strong "arenas + Strata" story that fits the language design
- Defer to v1.1 as the AllocatorABI's first non-trivial impl

## Consequences

- **Positive — long-running programs are expressible.** `sgl watch`,
  servers, REPLs can run indefinitely by wrapping per-iteration work
  in `&with_arena`. Today they can't.
- **Positive — allocator agnosticism is structural, not aspirational.**
  Same shape as ADR 0003. v1.1 GC swap-in is mechanical — implement
  the WIT, change a config flag.
- **Positive — no per-allocation overhead.** Stack-discipline arenas
  free in O(1) (one pointer write). No object headers, no mark phase,
  no write barriers.
- **Negative — tail-position + flat-type restriction during 1.0.**
  `&move_to_parent_arena` must be the arena body's tail expression
  (not buried mid-block), and the value's type must be a contiguous
  heap block (no nested heap references). Mitigations:
  - Compile-time errors with specific hints — "move this call to the
    tail of the `&with_arena` block" / "type `T` contains a nested
    heap reference; v1.1 will support deep promotion."
  - Document the pattern in `docs/memory.md` (new file in Phase 9c).
  - Tail-only is the common case in practice — code that wants to
    return a built-up String/array does so at the end of the block
    anyway.
  - Most one-shot programs never need `&with_arena` and never hit this.
- **Negative — heap exhaustion semantics still rough.** Today a
  too-large allocation either traps or corrupts. v1.0 needs at least a
  clean trap with a documented message; `memory.grow` integration is
  v1.1+.
- **Negative — write barrier / object header impact on v1.1 GC.** When
  the GC lands, allocations need headers to be walkable. Two paths:
  (a) headers always present (small per-alloc overhead even when GC
  unused), (b) headers added only when the GC allocator is active
  (allocator-aware codegen). The ABI design must accommodate (b) so
  GC-free programs pay nothing.
- **Follow-up work:** tracked as **Phase 9c** in
  `docs/v1-user-stories.html`. Summary:
  - **M-1 (gate — must land before this ADR moves to Accepted):**
    `wit/allocator.wit` published. Same shape as `wit/comptime.wit`.
    Documents `alloc`, `realloc`, `enter_scope`, `exit_scope`,
    `free_all`, `promote`. Future allocators conform.
  - **M-2:** `&with_arena` stratum lands. Compiler emits the
    save/bump/restore sequence. Value-type-return path verified.
  - **M-3:** `&move_to_parent_arena value` for flat heap types.
    Tail-position enforced at IR lowering; nested-heap detection
    enforced at typecheck. Runtime helper `$arena_promote(ptr, size)`
    added to the prelude.
  - **M-4:** Heap-exhaustion handling — clean trap with diagnostic
    message; `--max-heap=N` CLI flag for testing exhaustion paths.
  - **M-5:** Document the arena-passing pattern in
    `docs/getting-started.md` and `docs/memory.md` (new).
  - **M-6 (v1.1):** mark-sweep GC stratum implementing
    `wit/allocator.wit`. First non-trivial dogfood of the ABI.
  - **M-7 (v1.1):** trace-and-copy extension of
    `&move_to_parent_arena` for nested heap types (`Vec[String]`,
    sum-with-heap-payloads). Lifts the v1.0 flat-type restriction.
  - **M-8 (v1.1):** lift the tail-position restriction —
    `&move_to_parent_arena` callable from anywhere in the body via
    pointer-fixup pass.

## Implementation pointer

**Accepted 2026-05-26.** M-1 met: `wit/allocator.wit` published as the
canonical ABI surface (mirrors `wit/comptime.wit`'s shape). M-2 and the
v1.0 portion of M-3 shipped in the same change — `@with_arena` /
`@move_to_parent_arena` strata wired through `src/ir/lower.ts`, runtime
helper `$arena_promote` exported by the prelude, 11 e2e tests in
`src/codegen/arena.test.ts`. Remaining milestones (M-3 follow-ups for
Array / Sum-with-payloads, M-4 heap-exhaustion, M-5 docs, M-6+ v1.1) are
tracked as Phase 9c stories in `docs/v1-user-stories.html#phase-9c`.
