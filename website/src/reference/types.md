---
title: Types
---

# Types

Silicon has a small primitive set plus the structural types built on
top of them.

## Integer hierarchy

| Surface | WAT type | Notes |
|---------|----------|-------|
| `Int`   | `i32` (wasm32 target) | Target-sized signed. Default for unsuffixed integer literals. |
| `Int32` | `i32` | Alias for `Int` today; reserved for guaranteed-32-bit code paths once wasm64 lands. |
| `Int64` | `i64` | Always 64-bit regardless of target. Required for WASI surfaces with 64-bit fields. |
| `u8` / `u16` | `i32` (with narrowing) | Unsigned 8 / 16. Codegen routes to `*_u` variants. |
| `u32` | `i32` | Unsigned 32. |
| `u64` | `i64` | Unsigned 64. |

Conversions are explicit:

- `@toInt64(x)` — `Int → Int64` (sign-extend; `i64.extend_i32_s`).
- `@toInt(x)` — `Int64 → Int` (wrap; `i32.wrap_i64`). Typed-dispatch
  overload; the `Float → Int` variant of `@toInt` still applies for
  `Float` arguments.

No implicit promotion: `5 + @toInt64(1)` is a type error — both sides
must be the same width.

No integer-literal suffixes — `42i64` does **not** parse. Use the
keyword cast: `@toInt64(42)`.

**Non-decimal literals:** `0x` hexadecimal, `0b` binary, `0o` octal (prefix is
case-insensitive; `_` digit separators allowed) — e.g. `0xFF` (255), `0b1010`
(10), `0o17` (15).

**No operator precedence** (by design): binary operators fold strictly
left-to-right, so `2 + 3 * 4` is `20` (`(2 + 3) * 4`), **not** `14`. There is no
precedence table — express precedence with **parentheses**: `2 + (3 * 4)`. This
keeps the parser trivially simple and bootstrappable (Pony/Smalltalk lineage).

## Float

`Float` is `f64`. Arithmetic operators dispatch by operand type via the
strata registry; when both operands are `Float`, `+` resolves to
`f64.add`, etc.

## Bool

`Bool` is `i32` under the hood (`@true = 1`, `@false = 0`). The
comparison operators (`==`, `<`, `<=`, …) return `Bool`.

## Str

`Str` is UTF-8, length-prefixed (4-byte little-endian header).
`$str_concat` in `src/codegen/std.wat` is byte-based; equality is a
byte-by-byte memcmp.

Generalised: `Str → Slice[u8]` is the design conclusion; the surface
type `Str` and `Slice[u8]` are interchangeable in v1.x once the
generalisation lands.

## Slice[T]

A `Slice[T]` is `{ ptr Int, len Int }` — bounds-checked at runtime by
`Slice::get(...)`. The slice does not own its memory.

## Arrays and Vecs

Silicon has two collection types, and they differ sharply in what you can
do with them **today**. The short version: **reach for `Vec` for almost
everything; `$[...]` arrays are fixed literals that are not yet first-class.**

### `Vec[T]` — the growable, general-purpose collection

A `Vec[T]` is a heap-backed, resizable buffer. It's represented as a single
`Int` header pointer, so — unlike an array — it reads, indexes, iterates, and
passes through functions cleanly. Bring it in with `@use 'vec'`:

```silicon
@use 'vec';

@mut v := vec_new(4);        \\ initial capacity
vec_push_i32(v, 10);
vec_push_i32(v, 20);
n := vec_len(v);             \\ 2
x := vec_get_i32(v, 0);      \\ 10
@loop(i, e, v, { … });       \\ index + element for-each
```

API: `vec_new`, `vec_push_i32`, `vec_get_i32`, `vec_set_i32`, `vec_len`,
`vec_pop_i32`, `vec_map_i32_i32`.

### `Array[T]` — a fixed, homogeneous literal

An array literal is written `$[1, 2, 3]` (note the leading `$`) and has type
`Array[Int]`. All elements must share one type — `$[1, 'x']` is a compile
error. The layout is `[count:i32, e0, e1, …]` — `4 + count × sizeof(T)` bytes
(see [memory](../guide/memory)).

::: warning Arrays are not first-class yet
In the current compiler an `$[...]` array has **no in-language element read/write
or indexing syntax**, no length accessor that type-checks, and `Array[T]`
**cannot be written as a function parameter or return type**. You can construct
one, bind it locally, and move it between arenas (arena promotion) — but to
*read, index, or iterate* elements, or pass a collection to a function, use a
`Vec`. Treat `$[...]` as a fixed literal for local / arena use until arrays gain
element access.
:::

### At a glance

| | `Array[T]` — `$[…]` | `Vec[T]` — `@use 'vec'` |
|---|---|---|
| Size | fixed (literal) | growable |
| Read / index elements in-language | ✗ not yet | ✓ `vec_get_i32` |
| Iterate with `@loop` | ✗ | ✓ `@loop(i, x, xs, { … })` |
| Pass to / return from functions | ✗ (no writable `Array` annotation) | ✓ (it's an `Int` handle) |
| Push / mutate | ✗ | ✓ `vec_push_i32` / `vec_set_i32` |
| Typical use | fixed local literal, arena promotion | general-purpose collection |

**Rule of thumb:** use `Vec` unless you specifically need a fixed literal you'll
only build and hand off locally.

## Structs

`@type Point := { x Int, y Int };` lays out fields contiguously. The
constructor function `$Point` returns a pointer to the heap-allocated
struct. Nested structs compute their size at compile time
(`size_of(T)` is a comptime constant).

## Sum types

`@type Shape := $Circle r Int | $Rect w Int, h Int;` pads each variant
to the max payload width. Layout: `[tag:i32, field0:i32, …,
field<max-1>:i32]` with zero-init in unused slots.

Payload-free sum types (enums): `@enum Color := Red | Green | Blue;`.

Parametric sum types: `@type Option[T] := $Some value T | $None;`.
`Option[Int]` and `Option[Float]` are nominally distinct.

## Function types

`(Int, Int) -> Int` is a function type — a function taking two `Int`
arguments and returning `Int`. In a signature line: `\\ apply ((Int, Int) -> Int, Int) -> Int`.
Function values are indexes into the WebAssembly function reference
table; calls go through `call_indirect`.

**Signatures are optional.** A `@fn` whose parameters have no `\\` signature has
its parameter types **inferred from its call sites** — *monomorphically*: they
must resolve to one concrete type, or you get a "could not infer" error
(annotate it, or use `[T]` for a real generic). It's a convenience for
app-internal code; annotate a library's public API. See the
[type-inference reference](/reference/hm-lite).

## Type aliases / distinct types

- `@type UserId := Int;` — transparent alias (when RHS is a bare `TypeExpr`).
- `@type_distinct UserId := Int;` — nominally distinct from `Int`;
  explicit conversion required at the boundary.
