# Changelog

All notable changes to Silicon and the `sgl` / `sigilc` compiler toolchain.

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
and the stability commitments documented in [`docs/stability.md`](./docs/stability.md).

## 1.0.0 — 2026

The first stable Silicon release.

### Highlight reel

1. **Strata 2.0** — language features as Silicon source. Operators (`+`, `<=`,
   `==`), control flow (`@if`, `@loop`, `@match`), and definition keywords
   (`@fn`, `@let`, `@struct`, `@type`, `@enum`) are all defined in
   `src/strata/*.si` and dispatched data-drivenly. The compiler core does
   not switch on keyword strings.
2. **Arena-based memory management with parent-arena escape** —
   `&with_arena { … }` scopes allocation, `&move_to_parent_arena value`
   promotes a flat-heap value out of the current arena tail-position.
   Heap exhaustion is a clean trap, capped with `--max-heap=N`.
3. **Native compilation via QBE** — `sgl build --native` produces a
   freestanding native binary on Tier 1 platforms with no runtime
   dependency. Self-host verified.

### Language

- `@struct` product types — declarations, field read/write, nested struct
  + `size_of`, constructor function generation. The compiler's own
  aggregate types migrated to `@struct`.
- `@type Shape := $Circle r:Int | $Rectangle w:Int, h:Int;` — sum types
  with payloads; constructor functions, pad-to-max layout, `@match`
  destructure by name.
- `@type Option[T] := $Some value:T | $None;` — parametric sum types;
  variant constructors are polymorphic.
- `@enum` — payload-free tagged variants (i32 globals); `@type_sum` accepted
  as a legacy spelling.
- `@type_alias`, `@type_distinct` — accepted by the typechecker.
- HM-lite type inference — Hindley-Milner restricted to declared
  polymorphism on `@fn[T]` and `@type[T]`, no let-generalisation.
  Call sites infer `T` automatically.
- `@match` — a flat function-call form: the discriminant, then alternating
  `pattern, { body }` arguments (each body a block); per-arm pattern
  alternation `$Red | $Green, { 1 }`; an optional trailing `{ body }` default.
  The infix `pattern => body` arm form was removed — an infix `=>` collided
  with Silicon's flat (left-to-right) operator precedence once a body was
  itself a binary expression; a `{ }` block body removes the ambiguity with no
  precedence rule or AST rewrite.
- `@defer` — LIFO cleanup at every function exit (return, fall-through,
  break, continue). Replaced the compiler's own arena-cleanup paths.
- `@try` — Result unwrap shorthand (prefix-keyword, since Silicon bans
  postfix operators).
- `u8` / `u16` / `u32` / `u64` unsigned integer types with `*_u` codegen
  variants for unsigned division, shift-right, and comparison.
- `Int` (target-sized) / `Int32` (alias) / `Int64` (always 64-bit) hierarchy.
  Explicit `&@toInt64` / `&@toInt` casts — no implicit promotion.
- First-class function references, indirect call (`call_indirect`),
  function-type as a first-class `SiliconType`.
- Slices — `Slice[T]` (ptr+len) with bounds-checked indexing; `String`
  generalised to `Slice[u8]`.
- `$fn` annotation in surface syntax (function-typed parameters).

### Stdlib

- `Option[T]` / `Result[T,E]` with `unwrap` / `unwrap_or` / `map` / `is_some`.
- `Vec[T]` — growable array with `alloc` / `grow` / `len` / index; `map`
  taking a first-class function callback.
- `HashMap[i32, i32]` — open-addressing hash table.
- `Rc<T>` — single-threaded reference-counted smart pointer.
- `io.si` — WASI-backed `print` / `println`.

### Compiler-as-a-Service (CaaS)

The library-first API surface is stable at 1.0.

- Immutable red-green syntax tree (`src/caas/syntax/`).
- `SemanticModel` — queryable semantic information by document.
- `Workspace` — multi-document project state.
- Symbol-table API — declarations, references, navigation.
- `parse` / `buildRegistry` / `elaborate` / `typecheck` / `lower`
  exposed as the public entry points.
- Diagnostics as data: structured `Diagnostic` records with `severity`,
  `code`, `range`, `message`, `hints`.
- `sgl` CLI is rewritten as a CaaS consumer; `sgl fmt` walks the
  SyntaxTree (no re-parse).
- Stability contract documented in `docs/stability.md` and
  `docs/api-boundaries.md`; rolled-up surface in `etc/sigil.api.md`.

### Diagnostics

- Type-mismatch errors show both source spans (`E0001`).
- Unknown keyword / operator → Levenshtein-nearest registered name.
- `MissingReturn` (E0008) shows the signature + inferred return type.
- `ArityMismatch` (E0009) shows the expected parameter list.
- Undefined-name suggestions.
- Strata `&Compiler::diag::error` formatting matches native errors.
- Caret rendering documented in `docs/diagnostics.md`.

### CLI / tooling

- `sgl init` — scaffold a project (`sgl.toml`, `src/main.si`,
  `src/stdlib/io.si`).
- `sgl build` — compile to the default target.
- `sgl run` — compile and execute via wasmtime.
- `sgl check` — typecheck only; no codegen.
- `sgl fmt` — formatter (rewritten on the CaaS SyntaxTree).
- `sgl run --release` / `sgl build --release` — alias for the QBE
  native pipeline.
- `--target=wasm-gc` — opt-in WasmGC backend (see below).
- `--max-heap=N` — heap exhaustion cap.

### Backends

- **WAT / WASM** — primary backend; `binaryen` + `wabt` for assembly.
- **QBE → native** — Tier 1 platforms: linux-x86_64, linux-aarch64,
  macos-aarch64 (Apple Silicon Macs), macos-x86_64. Self-host verified.
  Native `sigilc` builds via `bun build --compile`.
- **WasmGC** (`--target=wasm-gc`) — opt-in; type-section emitter,
  instruction-level GC lowering, tagged-struct sum-type lowering,
  `Vec[Int]` under wasm-gc, cross-target test suite. Lifecycle
  primitives portable across targets; introspection / physical-byte
  primitives are MVP-only and rejected at typecheck under wasm-gc
  (E0012 / E0013).
- Abstract-IR opcodes — Strata emit backend-agnostic ops; WAT and QBE
  emitters each map them to instruction strings.

### Memory model

- `with_arena { body }` — save/restore heap pointer.
- `move_to_parent_arena value` — tail-position escape for flat-heap
  values; sum-with-payload byte-size respected.
- Heap-exhaustion clean trap; `--max-heap=N` flag.
- `heap_used` / `arena_used` introspection helpers.
- `wit/allocator.wit` ABI surface published.
- `Rc<T>` stdlib for shared ownership.

### Distribution

- GitHub Releases — binary tarballs for all four Tier 1 platforms
  on every `v*.*.*` tag, with SHA-256 checksums
  (`.github/workflows/release.yml`).
- Homebrew formula + tap (`packaging/homebrew/sgl.rb`).
- apt/deb package (`packaging/debian/build-deb.sh`).
- winget manifest for Windows-via-WSL
  (`packaging/winget/natescode.sgl.yaml`).
- `curl | sh` installer (`scripts/install.sh`).
- 15-minute getting-started tutorial
  ([`docs/getting-started.md`](./docs/getting-started.md)).

### Docs

- `docs/strata.md`, `docs/compiler-api.md`, `docs/compiler-as-a-service.md`,
  `docs/hm-lite.md`, `docs/diagnostics.md`, `docs/getting-started.md`,
  `docs/stability.md`, `docs/api-boundaries.md`, `docs/grammar.ebnf`,
  `docs/memory.md`, `docs/strata-authoring-guide.md`.
- Ten Architectural Decision Records under `docs/adr/`.
- `CONTRIBUTING.md` + `NOTICE.md` at repo root.
- Stability page renders `docs/stability.md` + ADRs.

## Stability statement

At 1.0 the language surface, the `&Compiler::*` strata API, and the public
CaaS API in `src/caas/` are committed surfaces. Additive changes are fine;
removals or breaking changes require a major version bump. See
[`docs/stability.md`](./docs/stability.md) for the per-surface tables and
extension rules.

## Known limitations

1.0 deliberately ships without the following. None are blocking; each is
a v1.x story:

- **No LSP server.** The CaaS API is the foundation; the LSP wrapper is
  a v1.1 deliverable.
- **No package registry.** `sgl add` / `sgl.lock` / a git-backed index
  exist as designed v1.x stories; for 1.0, dependencies are local-path
  only.
- **No Silicon-native comptime interpreter.** Comptime handlers run on
  the host; ADR 0003 pivoted the interpreter to v1.1.
- **No incremental compilation.** Full-document re-parse on edit; full
  project typecheck on change. The CaaS architecture supports
  incremental — the implementation is a v1.1 story (CaaS-7 sub-document,
  CaaS-8 semantic delta propagation).
- **No code-action / quick-fix API.** Diagnostics-as-data is shipped;
  the `CodeAction` surface that turns a diagnostic into a `TextEdit` is
  v1.1 (CaaS-11).
- **No interactive browser playground.** v1.1 stretch goal.
- **No multi-version docs site.** At 1.0 there's one version; the URL
  structure supports it landing later.

## Migration

N/A. 1.0 is the first stable release; there are no pre-1.0 users.

This section is stubbed for v1.1.

## Acknowledgments

Sigil is © 2024–2026 NatesCode LLC, Nathan Hedglin. Third-party
dependency licenses are recorded in [`NOTICE.md`](./NOTICE.md).
