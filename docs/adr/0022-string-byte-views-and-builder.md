# ADR 0022 — Strings as byte views: explicit `bytes` / `code_points` / `width` accessors + `StrBuilder`

- **Status:** Accepted — **stdlib surface implemented** (2026-06-07): `str_bytes` (`slice.si`), `str_code_point_count` + `str_decode_cp`/`str_decode_len` + experimental `str_width` (`str.si`), and `StrBuilder` (`strbuilder.si`), all on the **existing `Slice[u8]`**. The `Slice→Span` rename + `View`/`Slice` capability split (ADR 0011 addendum) is **deferred with the borrow checker** — it is cosmetic until enforcement exists, so `str_bytes` returns `Slice[u8]` today and becomes `View[u8]` then. Optional `str.si` rewrite (derive the existing helpers from `str_bytes`) also deferred. Tests: `compiler/src/stdlib/strext.test.ts`.
- **Date:** 2026-06-07
- **Deciders:** NatesCode
- **Related:** ADR 0011 §`Span`/`View`/`Slice` addendum (the capability'd span types this consumes) · `compiler/src/stdlib/str.si` (current byte helpers) · `compiler/src/stdlib/num.si` (the `alloc_string` + `i32_store8` + `heap_align` build pattern) · `docs/reference/types.md` (`Str → Slice[u8]` design conclusion; `String` layout) · `docs/guide/memory.md` (string layout, arena promotion)

## Context

Silicon strings are length-prefixed UTF-8 in linear memory: `[4-byte LE
length][UTF-8 bytes]`, with the pointer addressing the length header. Working
with them today leans on **manual pointer arithmetic**:

- Every `str.si` helper re-derives the data pointer by hand — `str_byte_at`,
  `str_eq`, `str_slice` all compute `str_ptr(x) + 4`. The `+4` is duplicated at
  every site instead of living in one place.
- There is **no string builder**. Constructing a string from bytes/chars means
  the raw `alloc_string(n)` + `WASM::i32_store8(str_ptr(s) + 4 + i, …)` +
  `heap_align()` dance (see `num.si`'s `int_to_str`). This is the ergonomics wart
  that surfaced building an array/Vec → `String`.
- There is **no unified byte view**: generic byte routines (e.g. `mem_eq`) take
  raw `(ptr, len)` `Int`s, so a string must be hand-unpacked to
  `(str_ptr+4, str_len)` at every boundary.
- Helpers are **byte-level only** — "indices are UTF-8 bytes, not code points" —
  with no code-point or display-width access.

`docs/reference/types.md` already records the intended direction: *"`Str →
Slice[u8]` is the design conclusion; `Str` and `Slice[u8]` are interchangeable."*
This ADR makes that concrete on top of the `Span`/`View`/`Slice` types from the
ADR 0011 addendum.

## Decision

A `String` exposes **three explicit accessors**, each naming a different notion of
"length/content" (conflating them is the classic bug), plus a **builder** for the
construction side. **No implicit coercion** — consistent with Silicon's ethos
(explicit casts, no hidden promotion).

1. **`String.bytes` → `View[u8]`.** A zero-cost read view over the data region
   (`ptr + 4`, `len`). O(1). This is the *one* place the `+4` header arithmetic
   lives; all byte reading/searching/slicing goes through the `View` (and its
   bounds-checked accessors) — no downstream code touches the header again.
   `str.si` is rewritten to derive everything from `String.bytes`.
2. **`String.code_points` → an iterator/decoder of `Int` Unicode scalar values.**
   O(n) UTF-8 decode. Used for char-level iteration (`@loop(i, cp, s.code_points,
   { … })`). Distinct from `bytes` so callers never accidentally index into the
   middle of a multi-byte character.
3. **`String.width` → `Int` (display column width).** O(n). **Experimental v0:**
   an East-Asian-Width approximation (wide = 2, default = 1, zero-width/combining
   = 0); documented as *approximate* — no grapheme-cluster / ZWJ-emoji handling
   yet. The API is stable; the implementation refines over time.

4. **`StrBuilder`** — a growable byte buffer (backed by a `Vec[u8]`) for
   *constructing* strings without pointer math:
   - `str_builder(cap)` → a builder,
   - `sb_push_byte(b, x)`, `sb_push_code_point(b, cp)` (UTF-8 encode),
     `sb_push_str(b, s)`,
   - `sb_finish(b)` → `String` (seals the buffer, sets the length header, and
     does the single `heap_align`).
   Internally it fills a `Slice[u8]` (exclusive, mutable — from the ADR 0011
   addendum); externally the header/alignment ritual is invisible.

### Symmetry

`String.bytes` → `View[u8]` (read, may overlap) and `StrBuilder` → `Slice[u8]`
(exclusive, mutable) are the read/write halves of the same `Span` story. An
immutable `String` yields a `View`; a mutable builder hands out a `Slice`. Same
split as everywhere else.

## Options considered

### Option A — Status quo: manual pointer arithmetic
Keep `str_ptr(s) + 4` + `i32_store8` at each site. **Pros:** nothing to build.
**Cons:** the `+4` is duplicated and leaks the header into user/stdlib code; no
builder; no unified view; the array/Vec→String recipe stays ugly. Rejected.

### Option B — Implicit `String` ⇄ `Slice[u8]` coercion
Let any `View[u8]`/`Slice[u8]` parameter silently accept a `String`. **Pros:**
maximally "automatic." **Cons:** hidden magic — violates Silicon's no-implicit-
coercion rule (no int promotion, explicit `@toInt64`). Rejected on ethos grounds;
the user explicitly chose explicit accessors.

### Option C — Explicit accessors + `View`/`Slice` + `StrBuilder` *(chosen)*
Explicit `bytes`/`code_points`/`width`; byte access flows through `View[u8]`;
construction through `StrBuilder` handing out `Slice[u8]`. **Pros:** header math in
exactly one place; symmetric read/write; consistent with the `Span` currency;
cost visible at the call site. **Cons:** new types + APIs; `code_points`/`width`
are O(n) and `width` drags in Unicode data.

## Consequences

- **Positive:** no user/stdlib code does `+ 4` ever again (it's inside
  `String.bytes`); building a string is a clean `StrBuilder` flow; byte routines
  written against `View[u8]`/`Slice[u8]` work uniformly on strings, `Vec`s, and
  arrays; the three "lengths" are named and their costs are explicit.
- **Negative:** `str.si` is rewritten on top of `String.bytes` (mechanical);
  `code_points` and `width` add UTF-8 decode + a Unicode width table; `width` is
  explicitly approximate at v0.
- **Depends on:** the ADR 0011 `Span`/`View`/`Slice` addendum landing first (or
  together) — `String.bytes` returns a `View[u8]`, `StrBuilder` fills a
  `Slice[u8]`.
- **Follow-up:** grapheme-cluster segmentation for an accurate `width`; possibly a
  `chars`/`graphemes` distinction; revisiting the `Str` ≅ `View[u8]`
  interchangeability note in `types.md` once these land.

## Implementation pointer

Once landed: commit SHA / PR. Order: (1) ADR 0011 addendum (`Span`/`View`/`Slice`,
rename `Slice` → `Span`); (2) `String.bytes → View[u8]`, rewrite `str.si` to
derive from it; (3) `StrBuilder`; (4) `code_points`; (5) experimental `width`.
