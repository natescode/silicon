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

## Type aliases / distinct types

- `@type UserId := Int;` — transparent alias (when RHS is a bare `TypeExpr`).
- `@type_distinct UserId := Int;` — nominally distinct from `Int`;
  explicit conversion required at the boundary.
