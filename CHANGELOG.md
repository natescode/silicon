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

### Added — v1.0 roadmap Phase 2 (closures, [ADR 0019](docs/adr/0019-first-class-closures-and-capture.md))

Delivered on the `phase-2-closures` branch and merged into the v1 roadmap.

- **C1 — non-escaping closures with by-value capture.** `@closure(body_fn, …caps)`
  and `@call_closure(clo, …args)` — first-class closures that capture surrounding
  values, the gap ADR 0016 named ("a callback cannot close over a surrounding
  accumulator"). Implemented as one AST→AST elaborator pass (`closureDesugar.ts`,
  modelled on `loopDesugar.ts`) with **zero new IR / codegen / grammar**: a closure
  is an i32 `Vec[i32]` env `[fnref, …caps]`; each site synthesizes an env-unpack
  wrapper `@fn(env, …args)` so all closures share one uniform `call_indirect`
  signature; invocation reuses the C0 multi-signature funcref ABI. Runs on every
  mode. Unblocks closures passed to higher-order functions (the combinator case).
- **C2 — escape/host-reachability gate.** A closure crossing an `@extern` boundary
  is a host-callable *escaping* closure whose captured env may outlive the call;
  a *bare* `@closure` crossing `@extern` is rejected (the conservative classifier,
  ADR 0019 §9), pointing the user at `@export_callback`. A plain `@fnref` still
  crosses; Silicon-side higher-order functions are unaffected.
- **C2 — host-callable closures.** `@export_callback(closure)` is the sanctioned,
  gate-exempt host escape: it hands a closure's handle across `@extern` to a JS/Bun
  host, which stores it and calls it back at an unbounded later time — with the
  captured environment intact — through a synthesized exported
  `__closure_invoke_<k>` trampoline. The full register→store→call-back round-trip
  is verified under Bun. Representation: the linear-memory baseline (the handle is
  an i32; the env is retained in the bump heap); the leak-free wasm-gc
  `(struct $Clo)` + `externref` form (engine GC) is the refinement that remains.
  ADR 0019 flipped Proposed → Accepted.

### Added — v1.0 roadmap Phase 0/1 (FFI object handles · monomorphization substrate · bindgen)

Delivered on the `phase-1-ffi-async` branch and merged into the v1 roadmap.
See [`docs/v1.0-implementation-roadmap.html`](docs/v1.0-implementation-roadmap.html).

- **C0 — multi-signature funcref ABI** ([ADR 0019](docs/adr/0019-closures.md)).
  `@call_indirect(cb, …args)` is variadic; the call signature is derived from the
  args' wasm types and registered in a multi-signature table. i32→i32 stays
  byte-identical.
- **F1a — `JSValue` generic externref object handle + `@extern` object-handle
  imports** ([ADR 0018](docs/adr/0018-async-promise-ffi.md) P0/P1). `JSString`/
  `JSValue` params, results, and locals lower to `externref`; a namespaced
  `@extern mod::field` imports from host module `mod` (not the hardcoded `env`)
  and is callable + forward-referenced. Externref imports are gated to
  `--platform=web|bun`. Lifts the FFI surface from scalar-only toward sync
  object-returning APIs.
- **M0 — comptime monomorphization substrate** ([ADR 0003](docs/adr/0003-comptime-via-compilation.md)).
  A Silicon-authored `@generic` stratum captures a template at `on::decl`, hands
  it across handler firings via a registry-shared handle table + per-stratum
  state, infers the call's type args, and emits a real `$id$Int` / `$id$Float`
  monomorph with substituted param/result types and a rewritten call — running
  under WebAssembly. New compiled-engine primitives `callee_name`,
  `type_bind_template_args`, `str_concat`; the block translator now tracks `@mut`
  and `<local>::field` access. (Same-type-call memoization, which needs comptime
  conditionals, remains future work.)
- **F0a — FFI binding generator** ([ADR 0017](docs/adr/0017-ffi-binding-generator.md), Accepted).
  `compiler/bindgen/` is now the single source of truth for the Web `Math`/clock
  `@extern` surface across `web.si` + the Bun and browser host shims. A CLI
  (`bun bindgen/cli.ts --check/--write`) splices each fragment between markers;
  a golden test enforces byte-for-byte fidelity, cross-site `(module, field,
  arity)` key parity, a lockfile content hash, and a round-trip compile of
  `web::math_sqrt`; `.github/workflows/bindgen.yml` gates drift. Generating
  collapsed the pre-existing ordering/whitespace drift across the three sites.

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
