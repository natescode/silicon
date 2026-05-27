# ADR 0009 — WasmGC target: opt-in `--target=wasm-gc` for v1.0

- **Status:** Proposed
- **Date:** 2026-05-26
- **Related:** ADR 0004 (Backend interface) · ADR 0008 (Memory management: arenas + AllocatorABI) · `wit/allocator.wit` · `src/codegen/wasm-emitter.ts`

## Context

The WebAssembly GC proposal reached Phase 5 (Standardized) in 2024. As
of 2026 it ships, on-by-default, in every browser engine and the
default Sigil runtime:

| Engine        | Version           | Notes                          |
|---------------|-------------------|--------------------------------|
| V8            | ≥ 11.5 (May 2023) | Chrome ≥ 119, Node ≥ 21, Deno ≥ 1.38 |
| SpiderMonkey  | ≥ 120 (Nov 2023)  | Firefox ≥ 120                  |
| JavaScriptCore| ≥ Safari 18.4     | shipped 2025                    |
| wasmtime      | ≥ 14.0 (Feb 2024) | Sigil's `sgl run` default       |

WasmGC introduces managed reference types alongside linear memory:

- `(type $t (struct (field i32) (field (ref $other))))` — nominal structs.
- `(type $a (array i8))` — homogeneous arrays.
- `(ref $t)` / `(ref null $t)` — typed refs; the engine GC tracks them.
- `struct.new $t v0 v1`, `struct.get $t 0 ref`, `array.new $a init size`,
  `array.get_s $a ref idx`, etc.
- Subtyping (`sub`, `final`) with cast via `ref.test` / `ref.cast`.
- The linear `(memory 1)` heap continues to coexist — programs can use both.

Today's Sigil exclusively uses linear memory:

- Heap = `(memory 1)`, allocations via `$alloc` (bump).
- Every heap-using stdlib type (`String`, `Vec`, sum-with-payloads,
  `Rc`) stores into linear memory at hand-computed offsets.
- Long-running programs use `&@with_arena` to bound the bump.
- Cycles or graphs that outlive any single arena scope are
  unsupported — ADR 0008's M-6 mark-sweep stratum was the planned
  v1.1 answer.

Three load-bearing facts:

- **WasmGC is here.** Not a future proposal — engines ship it,
  runtimes embed it, tooling supports it. Programs targeting the
  modern web in 2026 expect it.
- **The engine GC outclasses anything we'd hand-roll.** V8's
  Orinoco-class GC has had a decade of production hardening; Sigil's
  planned mark-sweep stratum would be a fraction of that maturity at
  any reasonable v1.x cadence.
- **Linear-memory programs still matter.** Embedded runtimes, some
  edge platforms, and any user who prizes deterministic latency want
  the arena story. The arena work in ADR 0008 / Phase 9c was not
  wasted — it's the right answer for a different problem.

The question is **how to ship WasmGC alongside the existing model**,
not whether to replace it.

## Decision

Three-part decision, mirroring ADR 0008's principle / instantiation /
runway shape.

**1. Architectural principle: target-flag-driven backend selection.**

The compiler already routes by target (`--target=host|wasix`) and by
backend (`--native` for QBE). WasmGC slots in as a third target:

| Flag                          | Heap model                          | Stdlib path           |
|-------------------------------|-------------------------------------|-----------------------|
| `--target=wasm-mvp` (default) | Bump allocator + arenas (Phase 9c)  | `src/stdlib/*.si`     |
| `--target=wasm-gc` (new)      | Engine GC; managed `ref` types      | `src/stdlib/gc/*.si`  |
| `--native`                    | QBE → native binary; future libc-bridge / native GC | `src/stdlib/*.si` |

Same source language; different lowering for memory-managed types.
The target is a whole-program decision; mixing managed refs and
linear-memory pointers in one module has sharp edges (the GC scanner
doesn't visit linear memory; refs stored in linear memory aren't
reachable) that 1.0 doesn't try to solve.

**2. v1.0 instantiation: minimum viable `--target=wasm-gc`.**

The smallest scope that lets a real user say "this works":

| Sigil surface          | wasm-mvp lowering                  | wasm-gc lowering                     |
|------------------------|------------------------------------|--------------------------------------|
| `Int`, `Float`, `Bool` | i32/f32/i32                        | i32/f32/i32 (unchanged)              |
| `Int64`, `UInt64`      | i64                                | i64 (unchanged)                      |
| `String`               | i32 ptr → `[len:i32][bytes…]`      | `(ref $String)` over `(array i8)`    |
| `Array[T]` (T value)   | i32 ptr → `[count:i32][elems…]`    | `(ref $ArrayInt)` over `(array (mut i32))` etc. |
| `@struct Point := …`   | i32 ptr → record in linear memory  | `(ref $Point)` over `(struct (field i32) …)` |
| Sum with payloads      | `[tag:i32, field0:i32, …]` pad-to-max | Tagged struct: `(struct (field i32) (field i32) (field i32) …)` — pad-to-max fields, mirror of today's linear layout |
| `Vec[T]` (T value)     | header `[len, cap, data_ptr]` + linear-memory buffer | header `(struct (field i32) (field (ref $array_T)))` + `(array (mut T))` buffer; value-typed T only (Int, Float, Bool, Int64, UInt8–UInt64) |

What's **rejected at typecheck** under `--target=wasm-gc` (with a
structured "this primitive is `--target=wasm-mvp` only" diagnostic):

- `&alloc`, `&realloc`, `&mem_copy`, `&heap_get`, `&heap_set`,
  `&heap_used`, `&arena_used`, `&str_ptr` — linear-memory primitives
  have no managed-mode equivalent.
- `&@with_arena`, `&@move_to_parent_arena` — scope-bounded
  reclamation isn't a managed-mode pattern. The GC handles it.
- `Rc` stdlib — replace with native managed refs (a `ref $T` is
  implicitly shared, cycle-safe, and zero-overhead).
- `Vec[T]` for ref-typed `T` (`Vec[String]`, `Vec[@struct Foo]`) —
  deferred to v1.1. Variance and cross-type-ref handling need
  design work; v1.0 ships value-typed Vec only (story 9d-8) to keep
  the typechecker bridge minimal.
- `HashMap[K, V]` — deferred to v1.1 GC stdlib. Needs ref-typed Vec
  as a prerequisite for its bucket array.

**Sum-type representation: tagged struct, not subtype hierarchy.**
v1.0 lowers `@type Foo := $A x:Int | $B y:Int` to a single struct
type per Sum:

```wasm
(type $Foo (struct (field i32) (field i32) (field i32)))
;; field 0: tag (0 = $A, 1 = $B, …)
;; fields 1..maxFields: pad-to-max payload slots, same shape as
;;                      today's linear-memory record layout.
```

Construction is `struct.new $Foo (i32.const tag) field0 field1`;
`@match` reads field 0 with `struct.get` and dispatches via the
existing tag-compare logic. Reuses Phase 9c-3a's `sumLayouts`
registry — same pad-to-max byte calc, emitted as a struct instead
of bytes. Subtype-hierarchy representation (variant-as-subclass,
`ref.test`-driven match) is a v1.1 optimization (story 9.1-d-1
in `v1.1-user-stories.html`); transparent source-level rewrite.

Programs that use *only* high-level types (`String`, `Array`,
`Vec[T value]`, `@struct`, sum types, `Option`, `Result`) compile
under either target. Programs using raw memory primitives stay on
`--target=wasm-mvp`.

**3. v1.1+ runway: representation upgrades, stdlib parity, defaults.**

- **Subtype sum representation.** Replace tagged-struct with
  variant-as-subclass (`(type $Sum (sub …))` + `(type $Variant (sub
  final $Sum …))`). Zero pad-to-max waste; `@match` dispatches via
  `ref.test`. Source-level identical to v1.0 — transparent
  optimization once we measure engine codegen quality across V8 /
  SpiderMonkey / JSC / wasmtime. Tracked as story 9.1-d-1.
- **Ref-typed `Vec[T]`** (`Vec[String]`, `Vec[@struct Foo]`).
  Backed by `(array (mut (ref $T)))`. Variance rules: WasmGC arrays
  are invariant by default; need a design call on whether
  `Vec[Cat]` widens to `Vec[Animal]`. Tracked as story 9.1-d-2.
- **Fully generic `@fn vec_push[T] v:Vec[T], x:T`** with
  monomorphization plumbed all the way to emit-time WasmGC
  type-index selection. Tracked as story 9.1-d-3.
- **`HashMap[K, V]`** under GC (story 9.1-d-4). Depends on
  ref-typed Vec.
- **Stringref** (separate proposal, currently Phase 3 of the
  standardization process): adopt when ≥ 80% of engines ship it;
  fallback to `(array i8)` otherwise.
- **Weak refs and finalizers** — the GC spec includes them; expose
  as a stratum.
- **Default `--target=wasm-gc` for new `sgl init` projects** in
  1.x. Existing `wasm-mvp` programs keep working forever.

## Options considered

### Option A — Default to WasmGC for 1.0; deprecate linear memory

- Pro: aligns with the "modern wasm" trajectory; one stdlib to maintain
- Con: breaks the deterministic-latency story the arena work was
  built for; immediate compat hit for embedders without GC enabled
- Con: invalidates Phase 9c three weeks after shipping it
- Reject

### Option B — No WasmGC for 1.0; ship in 1.1

- Pro: zero work
- Con: ships behind the platform; users targeting modern web have to
  go elsewhere; competitive positioning erodes
- Con: harder to add later when arenas/Rc patterns are entrenched in
  user code (every doc, every example, every blog post calcifies)
- Reject

### Option C — Opt-in `--target=wasm-gc` flag *(recommended)*

- Pro: zero compat risk for existing programs
- Pro: cleanly extends ADR 0004's backend-interface story
- Pro: aligns with `wit/allocator.wit` philosophy — pick the
  allocator strategy that fits your problem
- Pro: gives latency-sensitive users (arenas) and
  ergonomic-shared-ownership users (GC) both a first-class path
- Con: two stdlib paths to maintain — `src/stdlib/` and
  `src/stdlib/gc/`. Mitigation: most stdlib files are thin wrappers
  over a few primitives; gc-mode files mostly differ in the layout
  primitives, not the surface API.
- Con: cross-target porting requires user effort when raw primitives
  are used; mitigation is the structured diagnostic at compile time.

### Option D — Per-type `@gc @type Foo := …` annotation

- Pro: fine-grained control; users can pick GC for specific subgraphs
- Con: cross-domain references (managed → linear or linear →
  managed) are unsound by default and need extensive design
- Con: every stdlib type needs to support both modes, doubling
  surface area without doubling value
- Con: confusing mental model — "which heap is this on?"
- Reject

### Option E — Per-block `&@with_gc { … }` scope

- Pro: looks symmetric with `&@with_arena { … }`
- Con: scoped GC means objects can't escape the block, which
  defeats GC's main value (cycle-safe shared ownership across
  scopes)
- Con: the engine GC doesn't have a "scope" concept — it sweeps when
  it sweeps
- Reject

## Consequences

- **Positive — modern target ships.** Sigil compiles to current-web
  wasm; users get cycle-safe shared ownership without rolling Rc.
- **Positive — arena story preserved.** ADR 0008's work continues to
  serve programs that need deterministic latency (game loops,
  real-time, embedded).
- **Positive — clean extension of the backend interface.** ADR 0004's
  uniform `Backend<T>` shape absorbs WasmGC as another T.
- **Positive — type-system clarity.** "This program uses raw memory"
  and "this program uses managed refs" become inspectable
  properties, not buried implementation details.
- **Negative — two stdlib paths.** Mitigation: keep the *surface
  API* identical between `src/stdlib/*.si` and `src/stdlib/gc/*.si`
  (`&str_concat`, `&vec_push`, `&Some`, etc.). Layout differs;
  signatures don't. A user porting a program from mvp to gc changes
  one flag, not their call sites.
- **Negative — Rc + arenas become "mvp-only" idioms.** Mitigation:
  document loudly in `docs/memory.md` that on the gc target, the
  language gives you shared ownership for free via refs; arenas are
  for latency-sensitive code that picks linear memory deliberately.
- **Negative — type-system bridge work.** Sigil's nominal types
  (`@struct`, parametric sums) need to emit WasmGC type declarations.
  Variance and subtype rules require care, especially for parametric
  generics. Scope-control via v1.0 restrictions (no parametric refs
  in 1.0) keeps this contained.
- **Negative — testing matrix doubles for any code paths that touch
  heap layouts.** Mitigation: most existing tests are
  layout-agnostic. Only `arena.test.ts`, `allocator.test.ts`, the
  RC tests, and a handful of codegen tests need a gc-mode mirror.
  Estimated ~50 new tests, not 1000.

- **Follow-up work:** tracked as **Phase 9d** in
  `docs/v1-user-stories.html`. Summary:

  - **M-1 (gate — must land before this ADR moves to Accepted):**
    `wit/wasm-gc.wit` published. Documents the managed-ref ABI
    every gc-target stdlib type conforms to. Mirrors
    `wit/allocator.wit` in spirit.
  - **M-2:** WasmGC type-section emitter in
    `src/codegen/wasm-emitter.ts`. Emits `(type $foo (struct …))` /
    `(type $bar (array …))` declarations deduplicated by structural
    identity.
  - **M-3:** Instruction-level lowering for `struct.new`,
    `struct.get`, `struct.set`, `array.new`, `array.get_s`,
    `array.set`. (`ref.cast` / `ref.test` only when subtype
    representation lands in v1.1.)
  - **M-4:** `--target=wasm-gc` CLI flag wired through
    `sigil_cli.ts` → `LowerOptions.target` → emitter dispatch.
  - **M-5:** Typecheck rejection of mvp-only primitives under
    wasm-gc (`&alloc`, `&@with_arena`, `Rc`, `&heap_*`, etc.) with
    structured diagnostics.
  - **M-6:** `src/stdlib/gc/` — managed-mode `String`, `Array[T]`,
    `Option`, `Result`. `@struct` and sum types are compiler-level
    so they're covered by M-2 + M-3.
  - **M-7:** Sum-type lowering — tagged struct representation
    reusing Phase 9c-3a's `sumLayouts` registry.
  - **M-8:** `Vec[T]` for value-typed `T` (Int, Float, Bool, Int64,
    UInt8–UInt64). Backed by `(struct (len) (data))` header +
    `(array (mut T))` buffer. Mirrors today's
    `vec_*_i32` / `vec_*_f32` scope.
  - **M-9:** Cross-target test suite — same program compiled under
    both targets must produce equivalent results across the
    primitive types, `String`, `Array[T value]`, `Vec[T value]`,
    `@struct`, and tagged-sum types.
  - **M-10 (v1.1):** Subtype sum representation (transparent
    optimization).
  - **M-11 (v1.1):** Ref-typed `Vec[T]` (Vec[String],
    Vec[@struct]). Includes variance design.
  - **M-12 (v1.1):** Fully generic `@fn vec_push[T] v:Vec[T], x:T`
    with full monomorphization through the emitter.
  - **M-13 (v1.1):** `HashMap[K, V]` under GC (depends on M-11).
  - **M-14 (v1.1):** Stringref adoption (gated on engine coverage).
  - **M-15 (v1.1):** Weak refs + finalizers stratum.
  - **M-16 (v1.x):** Default `--target=wasm-gc` for new `sgl init`
    projects.

## Implementation pointer

Pending. **Move to Accepted only after M-1 (`wit/wasm-gc.wit`) lands.**
Same gate pattern as ADR 0003 and ADR 0008 — until the ABI is
published, the claim that "wasm-mvp programs port to wasm-gc by
changing a flag" is writing a check we can't yet cash.

Estimated end-to-end cost for v1.0 scope (M-1 through M-9):
~12 working days. Tracked as Phase 9d in `docs/v1-user-stories.html`.
