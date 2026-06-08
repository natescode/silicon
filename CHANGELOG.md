# Changelog

All notable changes to `sgl` (the Silicon compiler CLI) are recorded here.
This project aims for [Semantic Versioning](https://semver.org/).

## Unreleased

### Added — module / component system ([ADR 0024](docs/adr/0024-module-and-component-system.md))

- **Directory = module.** Inside a project (an `sgl.toml`-rooted component),
  files in `src/` are the ROOT module (callable unqualified); each `.si`-bearing
  sub-directory is a sibling module called as `mod::name`. All files in a module
  are **auto-included** (one Go-style package-block scope) — no `@use` between
  them. Modules statically merge into one core `.wasm` (zero runtime cost).
- **`@pub` visibility.** Module-private by default; mark a definition `@pub` on
  its `\\` signature line to make it callable across the module boundary
  (`E-PRIV` otherwise). `@export` (statement or new `\\ @export` modifier) is the
  host/WIT-world surface.
- **Dependencies.** `\\ @use name [as alias];` imports a `[dependencies]` `path:`
  component; its root `@export` surface is callable as `alias::fn` (statically
  merged, 2-segment at v1.0).
- **Diagnostics:** `E-DUP-MOD`, `E-DUP-DEF`, `E-MOD-TOPSTMT`, `E-MOD-CYCLE`,
  `E-PRIV`, `E-NO-MAIN`, `E-DEP-UNRESOLVED`, `E-DEP-CYCLE`, and a
  `W-USE-REDUNDANT` deprecation for intra-component path `@use`.
- **`sgl fix`** — codemod that removes redundant intra-component `@use`
  (keeps bare-name stdlib includes). `sgl init` scaffolds `[package].namespace`.
- Standalone files compiled outside a project keep the classic single-file
  `@use` behaviour unchanged.

## 0.1.5

Lands the **ADR-0020 grammar redesign** — a breaking change to Silicon's surface
syntax — plus optional function signatures, a richer string stdlib, and
non-decimal integer literals.

> **0.1.4 was yanked.** It mistakenly added an operator-precedence table, which
> contradicts Silicon's deliberate *no-precedence* design (binary operators fold
> left-to-right; precedence is expressed with parentheses — see `docs/grammar.ebnf`).
> 0.1.5 is 0.1.4 with that change reverted; the literal-prefix and other features
> are retained.

### Changed — ⚠️ breaking grammar ([ADR 0020](docs/adr/0020-odin-inspired-grammar.md))

- **Bare definitions.** `name := value` is an immutable binding; `@mut name := …`
  is mutable; `@fn name params := …` is a function; `@type` / `@enum` declare
  types. Removed `@local`, `@global`, `@var`, `@let`, `@struct`, `@type_sum`.
- **Always-parenthesized calls.** `add(2, 3)`. The `&` call sigil and every
  paren-free call form are removed.
- **Types are space-separated** (no colon): params and fields are `name Type`;
  function types live on a `\\` signature line (`\\ add (Int, Int) -> Int`).
- Existing sources migrate via `tools/migrate-adr0020.ts`.

### Added

- **Optional function signatures.** A `@fn` whose parameters have no `\\`
  signature has its parameter types **inferred monomorphically from its call
  sites**; a clear `E0015` fires only when inference genuinely can't decide
  (no concrete call sites, or call sites disagree — reach for `[T]`).
- **Non-decimal integer literals:** `0x` hexadecimal, `0b` binary, `0o` octal
  (case-insensitive prefix, `_` digit separators).
- **String stdlib** ([ADR 0022](docs/adr/0022-string-byte-views-and-builder.md)):
  - `str_bytes(s) -> Slice[u8]` — byte view that hides the length-header
    arithmetic (no manual `str_ptr(s) + 4`).
  - `str_code_point_count(s)` — Unicode code-point count (≠ byte length).
  - `str_width(s)` — display **column** width (experimental, East-Asian-Width
    approximation; no grapheme/ZWJ handling yet).
  - `StrBuilder` (`@use 'strbuilder'`): `sb_new` / `sb_push_byte` / `sb_push_str`
    / `sb_push_code_point` (UTF-8 encode) / `sb_finish` — build a `String` without
    pointer math.

### Docs

- New: [ADR 0021](docs/adr/0021-bounded-type-inference.md) (bounded inference,
  draft), [ADR 0022](docs/adr/0022-string-byte-views-and-builder.md), the
  `Span`/`View`/`Slice` addendum to ADR 0011, the optional-signatures-inference
  reference, the LSP-completion plan, and an Arrays-vs-Vecs reference.
- The docs→site sync now rewrites repo-relative links (to intra-site routes or
  absolute GitHub URLs), so the website has no dead links.

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
