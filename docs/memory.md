# Memory Management

Silicon's v1.0 memory model is **explicit arenas on top of a bump allocator**.
This page covers when to reach for the tools, the rules they impose, and the
v1.1+ roadmap.

> **TL;DR for one-shot CLI programs** — you don't need to do anything.
> The default heap is fine; the OS reclaims it when your program exits.
> Skip to [The default](#the-default-bump-allocator) only if you care about
> the internals.
>
> **TL;DR for long-running programs (servers, REPLs, watchers, anything in a loop)** —
> wrap per-iteration work in `&@with_arena { ... }`. If the iteration produces
> a heap value the parent scope keeps (e.g. a `String` response), make the
> last expression `&@move_to_parent_arena value`. See
> [`&@with_arena`](#the-with_arena-scope) and
> [`&@move_to_parent_arena`](#escaping-a-value-with-move_to_parent_arena).

---

## The default: bump allocator

Every heap-using stdlib type (`String`, `Vec`, sum types with payloads,
arrays) goes through a single bump allocator declared in
`src/codegen/std.wat` and `src/codegen/prelude-ir.ts`. The heap starts at
offset 1024 and grows monotonically. There is no per-object free list.

For programs that allocate, do their work, and exit, this is the right
answer:

- **Zero per-allocation overhead.** No headers, no bookkeeping.
- **Predictable.** The bump pointer is observable via `&heap_get`.
- **Simple to reason about.** Every allocation strictly comes after the
  previous one.

For programs that **loop**, this is a one-way ratchet:

```silicon
@fn server_loop:Int := {
    @var i:Int := 0;
    &@loop i < 1000000, {
        @local response:String := &str_concat 'reply: ', (&handle_request i);
        &send response;
        i = i + 1;
    };
    0
};
```

Every `&str_concat` call adds bytes to the heap that are never freed —
1,000,000 iterations later the program traps via the heap-exhaustion path
(see [`--max-heap`](#testing-heap-exhaustion)). The arena scope is how you
break the ratchet.

---

## The `&@with_arena` scope

```silicon
&@with_arena { body }
```

- Saves the current heap pointer at entry.
- Runs `body`. Allocations inside bump the heap as usual.
- On exit, resets the heap pointer to the saved value. Every byte
  allocated inside `body` is freed at once.
- The block evaluates to whatever `body`'s tail expression produces.
  Value types (`Int`, `Float`, `Bool`, payload-free enums) flow through
  unchanged.

Rewriting the server loop with an arena:

```silicon
@fn server_loop:Int := {
    @var i:Int := 0;
    &@loop i < 1000000, {
        &@with_arena {
            @local response:String := &str_concat 'reply: ', (&handle_request i);
            &send response;
        };
        i = i + 1;
    };
    0
};
```

Now the per-iteration `response` String is freed at the end of every loop
body. Memory usage is bounded by the largest single iteration, not by the
sum across iterations.

**Arenas nest.** They form a LIFO stack — an inner arena's exit restores
the heap pointer to the inner entry; the outer arena's exit further
restores to the outer entry.

```silicon
&@with_arena {                      # heap = H0
    @local a:String := 'outer';     # heap = H1
    &@with_arena {
        @local b:String := 'inner'; # heap = H2
    };                              # heap restored to H1
    @local c:String := 'more';      # heap = H1' > H1
};                                  # heap restored to H0
```

---

## Escaping a value with `&@move_to_parent_arena`

The arena reset frees everything. If the block needs to return a heap
value (`String`, `Array[T]` with `T` a value type, …) you'd hit a compile
error: the inner pointer would dangle. The fix is to **promote** the
value to the parent arena before the reset:

```silicon
@fn greet:String name:String := &@with_arena {
    @local hello:String := &str_concat 'hello, ', name;
    @local with_punct:String := &str_concat hello, '!';
    # ... work that allocates scratch strings ...
    &@move_to_parent_arena with_punct
};
```

What happens at the call site:

1. `&str_concat` builds up `hello`, then `with_punct`, plus arbitrary
   scratch strings that share the inner arena.
2. `&@move_to_parent_arena with_punct` looks at `with_punct`'s type
   (`String`), computes its contiguous byte size (`4 + length-header
   bytes`), and emits a runtime call to `$arena_promote`:
   - `memcpy` those bytes from inside-arena to the saved-pointer
     boundary;
   - bump the heap to `saved + size`, so the promoted bytes are kept
     and everything else is freed;
   - return the new (post-copy) pointer.
3. The block evaluates to that new pointer — a `String` that survives
   the arena reset.

### v1.0 rules

Two restrictions, both enforced at compile time:

**1. Tail position only.** `&@move_to_parent_arena` must be the arena
body's last expression — not buried mid-block. The compiler enforces
this and surfaces:

> `@move_to_parent_arena may only appear in the tail position of a &@with_arena { … } block (ADR 0008, Phase 9c; v1.1 will lift this restriction via pointer-fixup).`

If you need promotion mid-block, restructure so the work after the
promotion lives in an outer scope.

**2. Flat heap types.** v1.0 supports:

- Value types (`Int`, `Float`, `Bool`, `Int64`, `UInt8`–`UInt64`,
  payload-free enums) — no copy needed; just unwind.
- `String` — `4 + load-length` bytes.
- `Array[T]` where `T` is a value type — `4 + count × sizeof(T)` bytes.
- `Distinct` wrappers over any of the above.

Nested heap (`Array[String]`, `Vec[Vec[Int]]`, sum types with heap-typed
payloads) is **rejected** with a structured error. v1.1's
trace-and-copy extension will lift this.

### Why explicit?

Silicon avoids implicit memory operations. The same philosophy that
makes integer width casts explicit (`&@toInt64 x`) makes arena escape
explicit — the cost of the memcpy is visible at the call site, not
hidden in a return edge.

---

## Memory introspection

Two pure-read helpers let tests, dashboards, and CI memory budgets
observe the bump pointer:

- `&heap_used()` — bytes bump-allocated since program start
  (`heap - heap_base`). Resets when something lowers `heap` — most
  commonly an `&@with_arena` exit.
- `&arena_used(saved)` — bytes since a caller-supplied entry pointer.
  Pair with `&heap_get` to size the current arena without per-arena
  handles:

```silicon
&@with_arena {
    @local saved:Int := &heap_get;
    # ... do work ...
    @local cost:Int := &arena_used saved;
    &@if cost > 1000000, { &log_warn cost }, {};
};
```

Both are read-only — they don't allocate, don't fault, and don't
perturb the bump pointer. Safe to call from any context, including
inside the panic/trap paths of your own diagnostics.

## Reference counting with `Rc`

When arenas aren't the right tool — when a value's lifetime isn't
nested in a scope — Sigil ships a single-threaded `Rc` smart pointer
as plain stdlib (`src/stdlib/rc.si`). Layout: `[refcount:i32,
value:i32]`. Works for any 32-bit value: Int, Bool, String/Array/Sum
pointers.

```silicon
@use '/path/to/sigil/src/stdlib/rc.si';

@fn share:Int := {
    @local r := &rc_new 42;
    &@defer &rc_drop r;          # auto-decrement on every return path
    @local r2 := &rc_clone r;     # bumps count to 2
    &@defer &rc_drop r2;          # LIFO: drops in reverse declaration order
    (&rc_get r) + (&rc_get r2)
};
```

**Stratum composition is the value proposition.** `Rc` is just six
`@fn`s — no compiler changes, no new keyword. It composes with two
existing strata to cover the full lifecycle:

- `@defer` for scope-bound cleanup — `&@defer &rc_drop r` registers
  the drop at any return-path exit.
- `&@with_arena` for bulk free — `Rc` allocations inside an arena are
  physically reclaimed at arena exit regardless of refcount.

Together they cover Rust's `Rc` / `Box` / `Drop` story without
teaching the compiler any of them. That's the v1.0 stratum power
demo: ergonomic memory management as a library, not a language
extension.

**Caveat — physical free.** `&rc_drop` decrements the count but
doesn't reclaim memory (the v1.0 bump allocator has no free list).
The slot is logically dead at refcount 0; the bytes leak until the
enclosing arena resets or the v1.1 GC runs. In practice this is
fine — wrap `Rc`-using work in `&@with_arena` and the leak window
collapses to one iteration's allocations.

## Under `--target=wasm-gc` — portable lifecycle, no runtime cost

[ADR 0009](adr/0009-wasm-gc-target.md) adds an opt-in WebAssembly GC
target. The same source that uses arenas and `Rc` under
`--target=wasm-mvp` (the default) compiles cleanly under
`--target=wasm-gc`, with every lifecycle primitive collapsing to a
no-op at lowering time:

| Primitive | Under wasm-mvp | Under wasm-gc |
|---|---|---|
| `&@with_arena { body }` | Save/restore `$heap` | `{ body }` (no envelope) |
| `&@move_to_parent_arena v` | `arena_promote` memcpy | `v` (identity) |
| `&rc_new value` | Heap-allocate `[1, value]` | `value` (identity) |
| `&rc_clone r` | Bump refcount | `r` (identity) |
| `&rc_drop r` | Decrement refcount | `()` (no-op) |
| `&rc_get r` | Load value at `r+4` | `r` (identity) |

Two mechanisms, both compile-time:

1. **Stratum target-dispatch.** `lowerWithArena` and
   `lowerMoveToParentArena` inspect `ctx.target`; under wasm-gc they
   lower the body directly with no envelope.
2. **Stdlib shadow.** `src/stdlib/gc/rc.si` mirrors `src/stdlib/rc.si`
   with identity implementations. The `@use` resolver auto-redirects
   `…/stdlib/X.si` → `…/stdlib/gc/X.si` when target is wasm-gc and
   the shadow exists. No call-site changes in user code.

What's **rejected** under wasm-gc (introspection has no honest GC
semantics; raw pointers don't exist):

- **E0012 — introspection.** `&rc_count`, `&rc_is_unique`,
  `&heap_used`, `&arena_used`, `&heap_get`, `&heap_set`. Conservative
  no-op values would silently change branch behavior.
- **E0013 — raw memory.** `&alloc`, `&realloc`, `&mem_copy`,
  `&str_ptr`. Managed refs (`(ref $T)`) aren't addressable; no
  pointer math.

Programs that touch any of these primitives pick a target deliberately
(`sgl build --target=wasm-mvp` for raw-memory work; `--target=wasm-gc`
for managed-ref work). Programs using only the lifecycle layer +
high-level types (`String`, `Array[T]`, `@struct`, sum types,
`Option`, `Result`) compile under either target.

## Testing heap exhaustion

The `--max-heap=N` flag caps the wasm memory at N 64KB pages. Past the
cap, `memory.grow` fails and the bump allocator emits a clean WASM trap
(`unreachable`) instead of returning a sentinel pointer. wasmtime
surfaces the failure with a documented message.

```sh
# Cap at 2 pages (128KB) and watch allocation traps fire deterministically.
sgl run --max-heap=2 src/main.si
```

Use this in CI to verify that long-running programs stay inside their
arena bound — a `--max-heap` value just above the steady-state heap
size will catch any regression that leaks per-iteration allocations.

---

## v1.1 outlook

Phase 9c ships the v1.0 instantiation of [ADR 0008](adr/0008-memory-management-arenas.md).
v1.1 extends the same surface without changing v1.0 program semantics:

- **Mark-sweep GC stratum.** Implements the same `wit/allocator.wit`
  ABI as the bump allocator. Programs opt in via a compile flag; the
  allocator surface is byte-equal so existing code keeps running.
- **Deep promotion.** `&@move_to_parent_arena` extends to nested heap
  types via trace-and-copy — promoting a `Vec[String]` walks the value
  graph, recursively promotes reachable heap blocks, and rewrites
  internal pointers.
- **Lift tail-position restriction.** With a pointer-fixup pass, the
  promotion call becomes legal mid-block; the runtime tracks the
  in-flight pointer locals and rewrites them when the arena unwinds.

See [`docs/v1.1-user-stories.html`](v1.1-user-stories.html) for the
detailed milestones (M-6 through M-8 in ADR 0008's follow-up section).

---

## Cross-references

- [ADR 0008 — Memory management: explicit arenas for 1.0, AllocatorABI for 1.1](adr/0008-memory-management-arenas.md)
- [`wit/allocator.wit`](../wit/allocator.wit) — the ABI surface every
  Sigil allocator conforms to.
- [Phase 9c in `v1-user-stories.html`](v1-user-stories.html#phase-9c) —
  per-story acceptance bars.
- Source: `src/strata/control.si` (stratum declarations),
  `src/ir/lower.ts:lowerWithArena` (lowering),
  `src/codegen/prelude-ir.ts:buildArenaPromote` (runtime helper),
  `src/stdlib/rc.si` (Rc smart pointer).
