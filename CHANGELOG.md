# Changelog

All notable changes to `sgl` (the Silicon compiler CLI) are recorded here.
This project aims for [Semantic Versioning](https://semver.org/).

## 0.1.3

### Added
- **`@loop` over iterables** ([ADR 0016](docs/adr/0016-loop-over-iterables.md)) —
  one keyword, dispatched by the number of operands before the `{ body }` block,
  every form desugaring to the existing `while` primitive (no iterator object,
  no per-iteration allocation):
  - `&@loop { body }` — 0-operand infinite loop (exit with `&@break`).
  - `&@loop v, lo..hi, { body }` — half-open `..` ranges (`hi` excluded); a
    two-binder form `&@loop i, v, lo..hi, { body }` binds position then element.
  - `&@loop x, xs, { body }` / `&@loop i, x, xs, { body }` — i32-element `Vec`
    iteration via the `vec_len` / `vec_get_i32` surface.
  - `_` discards a binder (`&@loop _, 0..n, { … }`).
  - New `iter` stdlib module: `IterStep[T, R] := $Item value T | $Done result R`
    plus `iter_is_item` / `iter_is_done` / `iter_item_or` — the documented
    iterator-protocol convention (not yet auto-dispatched by `@loop`).
  - New example: `examples/loop_iterables.si`.
- New `..` range token in the lexer (recognised ahead of the `.` namespace
  separator); valid only as a `@loop` range subject.

### Fixed
- **Lowering**: a zero-argument builtin keyword (`@break` / `@continue`) no
  longer crashes the lowerer (`node is not an Object`) when a `SemanticModel`
  is present — `inferredTypeOf` now guards non-object nodes. This had broken the
  `&@loop 1, { … @break … }` loop-forever idiom on the CaaS / CLI compile paths.

## 0.1.2

### Added
- **Ergonomic snake_case standard library** so basic programs read like a
  high-level language ([docs/stdlib.md](docs/stdlib.md)):
  - `io` — `print`, `println`, `print_str`, `print_int`/`float`/`bool`,
    `eprint`, `exit`, `read_byte`, `read_line`.
  - `num` — `int_to_str`, `str_to_int`, `int_abs`/`min`/`max`/`clamp`/`pow`/
    `digits`, `float_abs`/`sqrt`/`min`/`max`/`trunc`, `float_to_str`.
  - `str` — `str_eq`, `str_byte_len`/`at`, `str_is_empty`, `str_starts_with`/
    `ends_with`, `str_index_of`, `str_contains`, `str_slice`, `str_repeat`.
  - `mem` — `heap_align`, `align_up`, `mem_fill`, `mem_eq`.
- **Language overview** ([docs/overview.md](docs/overview.md)) — a Go-Tour /
  Odin-overview-style tour, with Platforms and Strata sections.
- **Playground**: a collapsible left **cheatsheet** panel, topic-grouped
  examples following the overview, two new stdlib examples, and bare-name
  stdlib `@use` support (`@use 'num'`, `'str'`, `'mem'`).
- New examples: `fizzbuzz`, `strings_demo`, `floats_demo`, `calculator`
  (stdin), `bun_stdlib` (`--platform=bun`).

### Changed
- `sgl init` now scaffolds a stdlib hello-world (`@use 'io'` + `main`).

### Fixed
- **Typecheck**: a mutable local (`@var`/`@local`) now correctly shadows a
  same-named top-level immutable binding for assignment (no more false
  `ImmutableAssignment`).
- **Release CI**: the `v0.1.1` release never published — the `build-macos-x64`
  job sat "awaiting a runner" for 24h because GitHub retired the Intel macOS
  (`macos-13`) runners, and the publish job depended on it. The four per-OS
  build jobs are now one `ubuntu-latest` job that cross-compiles every target
  with `bun build --compile`. See
  [docs/release/v0.1.1-failure-postmortem.md](docs/release/v0.1.1-failure-postmortem.md).

## 0.1.1

Tagged but never published (see the postmortem above).

## 0.1.0

Initial public release of the `sgl` compiler.
