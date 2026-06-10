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
- `future.si` — the poll-reactor. A future is a poll-closure returning either a
  negative-sentinel `Int` (`block_on` / `block_all`) or the generic
  `Poll[T] := $Pending | $Ready value T` (`block_on_poll` / `block_all_poll` —
  the tag, not the sign, marks readiness, so a future may be `Ready` with any
  value). `tasks_new` / `spawn` / `poll_once` / `run_tasks` give a dynamic task
  surface; `block_all` polls every still-pending future each round so independent
  futures progress interleaved (true concurrency).
- `future_async.si` — a guest `Future` backed by a real host `Promise`, woken by
  the reactor: `block_on_async` drives one and `block_all_async` drives many
  concurrently, yielding to the event loop (`promise::tick`) between poll rounds.
- `ffi.si` — host-error / Promise-rejection → `Result`: `js_check` / `js_try`
  lift a caught host throw (a boundary error slot) into `Result[Int, String]`.

### Async & closures

- `@async` / `@await` / `@suspending` — signature-line markers (no grammar
  change). Coloring rule **E0016**: `@await` only inside an `@async` body.
- The async reactor (`runWithReactor`) drives a `@suspending`-using program from
  one vanilla binary, choosing the backend at load time: the **JSPI fast path**
  (`WebAssembly.Suspending` / `promising`; Bun 1.3.14+, V8/Node/Deno) else the
  **Asyncify** route-B unwind→await→rewind loop (precise coloring).
- Closures (ADR 0019): `@closure` / `@call_closure` (non-escaping, all targets,
  `Vec[i32]` env) and `@export_callback` (escaping, host-callable via a
  synthesized `__closure_invoke_<k>` trampoline). Under `--target=wasm-gc` the
  env is a `(ref $Vec_i32)` the engine garbage-collects — leak-free.
- Host concurrency: the `promise` module — `promise::all` / `race` /
  `all_settled` / `any` / `value` (all `@suspending`). Kick off N host operations
  un-awaited, join with one `@await`.

### FFI / host interop (web/bun)

- **Bindgen** (ADR 0017): WebIDL (`@webref/idl`) and Node/Bun `.d.ts` (the TS
  compiler API) → generated `@extern` modules + host shims, CI-gated byte-for-byte
  (`bindgen --check`, `bindgen.lock.json`). Three boundary tiers: Tier-0 (linear
  `String`), Tier-1 (`JSString` externref, zero-copy), Tier-2 (`JSValue` opaque
  object handle, engine-GC'd). Best-bindable overload selection; `Promise<T>`
  members → `@suspending`; callback params → closure handles.
- **The `js` module** — the generic object/array build-and-read substrate for
  `JSValue` handles: `object` / `array` / `set` / `push` / `get` / `len` / `keys`
  / `typeof` build options bags and inspect returned handles; `from_*` / `as_*`
  box/unbox Silicon scalars; `call` / `apply` / `construct` are fallible invokers
  feeding the boundary error channel (`had_error` / `error_message`); `pin` /
  `pinned` thread a handle through a `Result`; `bytes_in` / `bytes_out` /
  `byte_length` / `u8` bulk-copy binary between linear memory and typed arrays.
- **The `stream` module** — the JS iteration protocol: `iter` / `next` / `value`
  / `done` over any sync iterable, `aiter` / `anext` (`@suspending`) over async
  iterables / ReadableStream.
- **Generated modules**: `path` / `os` / `json` / `bun` / `url` /
  `url_search_params` / `headers` / `text_encoder` / `text_decoder`; the fetch
  ecosystem `response` / `request` / `blob` / `form_data` / `abort_controller` /
  `abort_signal` (Response body readers are awaitable `@suspending`); the event
  surface `event_target` (`add_event_listener` with a closure listener); Node
  `crypto` and `fs` (the mixed-union fix unlocked `read_file_sync` etc.); and bare
  globals `global::fetch` (first-class, `@suspending`) / `atob` / `btoa`. All
  externref-handle surfaces are web/bun only.
- **Classifier coverage** — the `.d.ts` and Web-IDL type classifiers now resolve
  generic params to their constraints, map `bigint` / `unknown` / IDL `any` and
  dictionaries (options bags) and `sequence<>` / `FrozenArray<>` to `JSValue`
  handles, and bind a `T | Promise<T>` union through its synchronous arm. Then the
  Web-IDL adapter gained the `events:'closure'` callback path (ADR 0019 C2): an
  `EventHandler` attribute → a setter taking a `Callback` closure handle, and a
  listener argument → a `Callback` param — recovering `abort_signal::set_onabort`
  and shipping the `event_target` module. (A `Callback` crosses only guest→host,
  so it is rejected in result/getter/union position; a fired listener can't yet
  consume its `Event` arg — see the doc.) Finally the last "fundamental" skips
  were closed: `Intersection`/`Conditional` types → `JSValue` (recovers `Bun.serve`
  / `Bun.plugin`), a variadic rest param → a spread Impl (`accessor.method(...args)`),
  a name sanitizer (no invalid `@extern` name can leak), and a static factory that
  collides with an instance member ships under a `_static` suffix (`Response.json`
  + `json_static`). `Bun.$` is detected as a tagged-template (a JS syntactic form,
  not a normal callable) and skipped. **No fundamental bindgen gaps remain.**
  Finally `path` / `os` flipped to `objects:'jsvalue'` (**mixed tier**): their
  string/scalar functions stay Tier-0 portable (any host, byte-identical), and
  their object/variadic members (`path::parse`/`format`/`join`/`resolve`,
  `os::cpus`/`loadavg`/`user_info`/`network_interfaces`) bind as Tier-2 `JSValue`
  (web/bun only — gated per call by `E0010`). Aggregate bind rate **90.1 % →
  99.74 %** (379 bindings, **1 skip** — only the `Bun.$` tagged-template). See
  [`docs/ffi-coverage-gaps.md`](../docs/ffi-coverage-gaps.md).

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
- **No container monomorphization.** `Vec`/`HashMap` are i32-element only;
  `Vec[Float]` / `Vec[Int64]` and HashMap iteration are v1.1 (M1).
- **No capability / borrow-checker model.** The ocap + effect-class +
  rcap (`&` / `&mut`) machinery (ADR 0011/0012/0013/0015) is post-v1.0; v1.0
  closures use by-value/immutable capture, which needs no borrow checker.
- **A sum type can't carry a host handle natively.** A `JSValue`/`JSString`
  (externref) can't be a `Result`/`Option` payload (generic sums share one
  linear/struct layout); thread a handle through a `Result` by `js::pin` id
  (an `Int`) instead. Native support follows generic-sum monomorphization.
- **Externref-valued `@suspending` results need JSPI.** Binaryen Asyncify can't
  carry reference types (binaryen#3739), so an awaited externref requires the
  JSPI backend — present on Bun 1.3.14+/V8/Node 24+; the Asyncify fallback
  covers scalar awaits.

## Migration

N/A. 1.0 is the first stable release; there are no pre-1.0 users.

This section is stubbed for v1.1.

## Acknowledgments

Sigil is © 2024–2026 NatesCode LLC, Nathan Hedglin. Third-party
dependency licenses are recorded in [`NOTICE.md`](./NOTICE.md).
