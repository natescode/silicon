# Silicon Standard Library

> Status: **shipping** (v0.1.2). This is the reference for the modules that
> ship with `sgl` today. The long-term, aspirational surface (async, JSON,
> HTTP, collections beyond `Vec`/`HashMap`, capability gating) is sketched in
> [`silicon_standard_library_v_1.md`](silicon_standard_library_v_1.md); this
> page documents only what is implemented and tested.

## Goal

Let basic Silicon programs read like a normal high-level language. WASI is
low-level (raw `fd_write`, iovecs, out-pointers, errno returns), so the stdlib
**wraps WASI and the runtime intrinsics behind ergonomic, `snake_case`
functions**. The target is covering ~80% of what small programs need:
printing, reading input, numbers ↔ strings, string manipulation, and basic
math — on every platform target.

```silicon
@use 'io';
@use 'str';

@fn main := {
    name := read_line();                       # read a line of input
    print('Hello, ' ++ name ++ '!');           # greet
    print_int(str_byte_len(name));             # its length
    0
};
main();
```

## How it is organized

Modules are plain Silicon source under `compiler/src/stdlib/*.si`, resolved by
bare name: `@use 'io';` loads `io.si`. They split into two tiers:

| Tier | Modules | Portability |
|------|---------|-------------|
| **Pure compute** | `mem`, `heap`, `num`, `str` | No host imports — only linear memory + intrinsics. Compile under native/WASI, `--platform=bun`, and `--platform=web`. |
| **Host I/O** | `io` | Native/WASI (`sgl run`, any WASI host). Uses `wasi_snapshot_preview1`. On bun/web, use `console` / `web` instead (see [Platforms](#platforms)). |

Across the *memory-mode* axis: `mem` (pure byte ops) also compiles under
`--target=wasm-gc`; `heap`/`num`/`str` use the wasm-mvp-only bump-pointer helper
`heap_align`, so they target wasm-mvp (their `--platform=bun`/`web` builds, which
are mvp-based, are unaffected).

Dependency direction: `io → num → heap → mem` and `str → heap → mem` (`heap`
re-exposes `mem`). `@use` deduplicates, so pulling in `io` transitively brings
`num`, `heap`, and `mem`.

A note on memory: the default allocator is a bump allocator that never frees
and does **not** align allocations. Building odd-length strings at runtime
leaves the bump pointer on an odd address, which makes the next WASI iovec
store trap under strict runtimes (wasmtime). Every stdlib string builder calls
`heap_align()` (from `heap`) before returning, and `io`'s write path re-aligns
defensively, so this is invisible to user code.

---

## `mem` — portable byte operations

```silicon
@use 'mem';
```

Pure address/arithmetic ops over linear memory — core + bulk-memory instructions
only, so `mem` compiles under **both** wasm-mvp and `--target=wasm-gc`.

| Function | Signature | Notes |
|----------|-----------|-------|
| `align_up` | `(Int, Int) -> Int` | Round `n` up to the next multiple of `a`. |
| `mem_fill` | `(Int, Int, Int) -> Int` | Write `n` copies of byte `b` from `ptr` (one `memory.fill`). |
| `mem_eq` | `(Int, Int, Int) -> Bool` | Compare `n` bytes at two addresses. |

`mem_copy(dst, src, n)` is a runtime prelude function (one `memory.copy`), always
available without a `@use`.

## `heap` — bump-pointer alignment (wasm-mvp only)

```silicon
@use 'heap';
```

| Function | Signature | Notes |
|----------|-----------|-------|
| `heap_align` | `() -> Int` | Round the bump pointer up to a 4-byte boundary. No-op when already aligned. |

`heap_align` reads/rewrites the allocator pointer via the prelude's `heap_get` /
`heap_set` — wasm-mvp-only introspection primitives with no honest wasm-gc
semantics, so `@use 'heap'` under `--target=wasm-gc` is an `E0012` error. The
portable byte ops live in [`mem`](#mem-portable-byte-operations).

---

## `num` — numbers & conversions

```silicon
@use 'num';
```

### Integer helpers

| Function | Signature | Result |
|----------|-----------|--------|
| `int_abs` | `(Int) -> Int` | `\|n\|` |
| `int_min` / `int_max` | `(Int, Int) -> Int` | smaller / larger |
| `int_clamp` | `(Int, Int, Int) -> Int` | `x` clamped to `[lo, hi]` |
| `int_pow` | `(Int, Int) -> Int` | `base ** exp` (exp ≥ 0) |
| `int_digits` | `(Int) -> Int` | decimal digit count of `\|n\|` |

### Conversions

| Function | Signature | Example |
|----------|-----------|---------|
| `int_to_str` | `(Int) -> String` | `int_to_str(0 - 42)` → `"-42"` |
| `str_to_int` | `(String) -> Int` | `str_to_int('123')` → `123` (signed; stops at first non-digit; `0` if none) |
| `uint_to_str_pad` | `(Int, Int) -> String` | zero-pad a non-negative number to a width |
| `float_to_str` | `(Float) -> String` | `float_to_str(2.5)` → `"2.500000"` (6 decimals, approximate) |

### Float helpers

| Function | Signature | Notes |
|----------|-----------|-------|
| `float_abs` | `(Float) -> Float` | |
| `float_sqrt` | `(Float) -> Float` | |
| `float_min` / `float_max` | `(Float, Float) -> Float` | |
| `float_trunc` | `(Float) -> Int` | truncate toward zero |

`float_to_str` is fixed at 6 fractional digits and is approximate — `f32`
carries ~7 significant digits. It is meant for everyday output, not exact
decimal formatting.

---

## `str` — string operations

```silicon
@use 'str';
```

Silicon strings are length-prefixed UTF-8 in linear memory. These helpers work
at the **byte** level (indices and lengths are UTF-8 bytes). They complement
the built-in `++` concatenation operator and the `str_len` / `str_ptr`
prelude views.

| Function | Signature | Result |
|----------|-----------|--------|
| `str_byte_len` | `(String) -> Int` | byte length (O(1)) |
| `str_is_empty` | `(String) -> Bool` | `len == 0` |
| `str_byte_at` | `(String, Int) -> Int` | byte at index `i` |
| `str_eq` | `(String, String) -> Bool` | byte-wise equality |
| `str_starts_with` | `(String, String) -> Bool` | |
| `str_ends_with` | `(String, String) -> Bool` | |
| `str_index_of` | `(String, String) -> Int` | first index, or `-1` |
| `str_contains` | `(String, String) -> Bool` | |
| `str_slice` | `(String, Int, Int) -> String` | bytes `[start, end)`, clamped |
| `str_repeat` | `(String, Int) -> String` | `s` repeated `n` times |
| `str_code_point_count` | `(String) -> Int` | number of Unicode code points (≠ byte length) |
| `str_width` | `(String) -> Int` | display **column** width (experimental, East-Asian-Width approximation) |

A string has **three different "lengths"** — bytes (`str_byte_len`), code points
(`str_code_point_count`), and display columns (`str_width`) — and they are not
interchangeable (`'中'` is 3 bytes, 1 code point, 2 columns). `str_width` is
experimental: wide CJK/fullwidth = 2, combining/zero-width = 0, else 1; no
grapheme-cluster / ZWJ-emoji handling yet.

Concatenation is the built-in operator: `'foo' ++ '-' ++ int_to_str(99)`.

### Byte view — `str_bytes`

`str_bytes(s) -> Slice[u8]` (in the `slice` module) is the read view over a
string's bytes — it hides the 4-byte length-header arithmetic, so you index
through `slice_get_byte` instead of writing `str_ptr(s) + 4` by hand.

### Building strings — `StrBuilder`

```silicon
@use 'strbuilder';

@mut b := sb_new(16);            # initial capacity (bytes)
sb_push_str(b, 'Hi');
sb_push_byte(b, 33);             # '!'
sb_push_code_point(b, 20013);    # 中 (UTF-8 encoded to 3 bytes)
s := sb_finish(b);               # "Hi!中"
```

| Function | Signature | Notes |
|----------|-----------|-------|
| `sb_new` | `(Int) -> StrBuilder` | new builder, initial byte capacity |
| `sb_push_byte` | `(StrBuilder, Int)` | append one byte (0..255) |
| `sb_push_str` | `(StrBuilder, String)` | append a string's bytes |
| `sb_push_code_point` | `(StrBuilder, Int)` | append a code point (UTF-8 encoded) |
| `sb_finish` | `(StrBuilder) -> String` | seal into a `String` (sets header, re-aligns heap) |

---

## `io` — console & file I/O (WASI)

```silicon
@use 'io';
```

Portable WASI wrappers — works on the native/WASI target `sgl run` produces and
any WASI host.

| Function | Signature | Notes |
|----------|-----------|-------|
| `print` | `(String) -> Int` | string + newline to stdout |
| `println` | `(String) -> Int` | explicit alias of `print` |
| `print_str` | `(String) -> Int` | string to stdout, **no** newline |
| `print_int` | `(Int) -> Int` | decimal + newline |
| `print_float` | `(Float) -> Int` | decimal + newline |
| `print_bool` | `(Bool) -> Int` | `"true"`/`"false"` + newline |
| `eprint` | `(String) -> Int` | string + newline to stderr |
| `exit` | `(Int) -> Void` | terminate with an exit code |
| `read_byte` | `() -> Int` | one byte from stdin, or `-1` at EOF |
| `read_line` | `() -> String` | a line from stdin, newline stripped |
| `write_bytes` / `write_str` / `write_nl` | low-level | raw `fd`-targeted writes (used by the above) |

---

## Platforms

The stdlib's pure modules (`mem`, `num`, `str`) compile on every target. I/O is
platform-specific:

| Platform | Output | Strings |
|----------|--------|---------|
| **native / WASI** (default) | `@use 'io'` → `print`, `read_line` (WASI `fd_write`/`fd_read`) | linear-memory `String` |
| **bun** (`--platform=bun`) | `console::log(...)` / `web::console_log_f(...)` | `JSString` (JS strings) + `String` bridge |
| **web** (`--platform=web`) | `web::canvas_*(...)`, `web::set_html(...)`, `console::log(...)` | `JSString` + `String` |

See [`js-string-builtins.md`](js-string-builtins.md) for the `JSString` type and
the `console` / `web` modules, and [`targets.md`](targets.md) for the wasm
memory-model targets (`wasm-mvp` vs `wasm-gc`), which are orthogonal to platform.

---

## Other shipped modules

Beyond the basics above, the stdlib also ships data structures (covered by their
own sources and tests):

| Module | What |
|--------|------|
| `option` | `Option[T]` sum type + `option_unwrap_or`, `option_is_some/none` |
| `result` | `Result[T, E]` sum type + `result_unwrap_or`, `result_is_ok/err` |
| `vec` | `Vec[T]` — the growable, general-purpose collection (`vec_new`, `vec_push_i32`, `vec_get_i32`, …). Prefer it when you need growth; for fixed-size data, `$[…]` array literals carry `array::get` / `array::set` / `array::len` (always available — no `@use`, like the literal itself), `Array[T]` param/return annotations, and iterate-`@loop` over an array subject. Elements are 4-byte (`Int` / `Float`) in v1.0. |
| `slice` | bounds-checked views (`Slice[T]` = `{ptr, len}`); also `str_bytes` / `string_as_slice` for a string's byte view |
| `strbuilder` | `StrBuilder` — build a `String` without pointer math (`sb_new`/`sb_push_*`/`sb_finish`) |
| `hashmap` | hash map |
| `rc` | reference counting (`gc/` shadow under `--target=wasm-gc`) |

---

## Design principles

1. **`snake_case` everywhere.** Function names read like C / Rust / Go stdlib.
2. **Portable-first.** Pure computation (`mem`/`num`/`str`) has no host
   dependency and compiles on every target. I/O is isolated in `io`.
3. **Wrap WASI, don't expose it.** User code calls `print(...)`, not `fd_write`
   with hand-built iovecs.
4. **Small and correct over large and clever.** This is the 80% surface; the
   aspirational stdlib (async, JSON, HTTP, capabilities) is tracked separately.
5. **Alignment is the library's problem, not the user's.** Builders re-align
   the bump pointer so runtime-built strings never trap a following write.
