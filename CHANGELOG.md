# Changelog

All notable changes to `sgl` (the Silicon compiler CLI) are recorded here.
This project aims for [Semantic Versioning](https://semver.org/).

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
