# Changelog

All notable changes to `sgl` (the Silicon compiler CLI) are recorded here.
This project aims for [Semantic Versioning](https://semver.org/).

## Unreleased

## 0.2.0

**The planned v1 surface is complete.** This release lands the full v1-roadmap scope (see [`docs/v1-feature-status.md`](docs/v1-feature-status.md)): the **FFI-coverage gate at 100%\*** (every bindable host member binds; `Bun.$` officially excluded by policy), the dependency chain `binding generator → object handles → async/await → closures → callbacks`, the **module/component system** (ADR-0024), full **monomorphization** (M0 + the M1 container tier), a minimal **object-capability model** (K0, ADR 0027), and a **runnable LSP server** (18 capabilities).

Versioned **0.2.0**, not 1.0.0, deliberately: **the 1.0 number is reserved for the post-bootstrap fixpoint** — a self-hosted compiler (`stage1 == stage2`), the native (QBE) backend at WASM parity, and the eternal-grammar promise activated only after self-hosting has stress-tested the language (see [`docs/bootstrap-blockers-and-order.md`](docs/bootstrap-blockers-and-order.md)). Headline capabilities:

- **First-class closures** (ADR 0019): `@closure`/`@call_closure` (non-escaping, all modes) and `@export_callback` (escaping host-callable). Under `--target=wasm-gc` the closure env is **engine-GC'd (leak-free)**.
- **Async/await** (ADR 0018): `@async`/`@await`/`@suspending` markers + a production reactor that picks **JSPI** (Bun 1.3 / V8) or **Asyncify** at load time, wired into `sgl run`.
- **Object handles** (ADR 0018): `JSValue`/`JSString` externref types — any host object crosses `@extern` as an opaque, engine-GC'd handle.
- **A spec-driven FFI binding generator** (ADR 0017) shipping built-in modules across every tier: `os`/`path` (Tier-0), `bun`/`json` (Tier-1 `JSString` + Tier-2 `JSValue`), and constructed Web interfaces `url`/`url_search_params`/`headers`/`text_encoder`/`text_decoder` — with `async:'suspending'` (Promise→`@suspending`) and `events:'closure'` (callback→closure) generation modes.
- **Full comptime monomorphization** (M0, ADR 0001/0003): per-call-site memoization + the production `@fn[T]`/`@generic` stratum (Float/Int64/host-handle instantiations specialize; i32-shaped stay erased). **Native host-handle sums** (F1) ride it — `Result[JSValue,E]`/`Option[JSValue]` under `--target=wasm-gc`, no `js::pin`. Plus a **poll-reactor** for true concurrency (`block_on`/`block_all`).
- **Container monomorphization complete** (M1): `Vec[Float]`/`Vec[Int64]` on both targets with element-typed `@loop`, typed `HashMap[K,V]` families with iteration cursors, and first-class `Array[T]` accessors.
- **Object-capability model v0** (K0, ADR 0027): unforgeable caps rooted at `@fn main (World)`, attenuated by `@cap_derive`.

See the per-ADR entries below for detail, and `docs/v1.0-implementation-roadmap.html` for subtask status.

### Added — LSP tail closed (cross-file diagnostics + binding identity); FFI gate declared 100%\*

**Cross-file diagnostic invalidation** (CaaS `Workspace.refreshDocument`/`refreshDependents`): an open document re-checks **without an edit** when the external symbols it sees changed. Invalidation is *signature-driven*, not graph-driven — each compile stores the `externalSymbolsSignature` it ran against, so a body-only edit elsewhere invalidates nothing and there is no `@use` dependency graph to keep correct; runs to a fixpoint. The LSP republishes refreshed documents: renaming `@fn add` in `lib.si` immediately surfaces E0004 in an open `main.si`, and restoring it clears the squiggle.

**S1 binding identity.** A new lexical binder (`src/ast/binder.ts`) assigns every local name occurrence (parameter, local, `@match` pattern field) to its concrete binding, mirroring the typechecker's scope rules. Symbols surface with `containingSymbol` populated; `findReferences`/`rename` are scope-correct — a param `x` never renames another fn's `x`, and a top-level rename skips occurrences a shadowing local claimed. Parameters carry their name-token span, so go-to-definition/hover work on params.

**FFI gate: 100%\*** (379/379 bindable members). The single remaining skip, `Bun.$`, is now **officially excluded by policy** — a tagged template is a JS *syntactic form*, not a callable member; binding it as a normal fn would destroy its per-substitution shell-escaping guarantee. The exclusion list is CI-pinned to exactly `['Bun.$']` (`bindgen/adapters.test.ts`); the optional honest path remains [`docs/bun-shell-ffi-plan.md`](docs/bun-shell-ffi-plan.md).

### Added — M1 completed: `@loop` over typed Vecs + typed HashMap families; first-class array accessors

**`@loop` over typed Vecs (both targets).** The iterate-`@loop` desugar runs pre-typecheck and emits i32-default `vec_len`/`vec_get_i32` calls — now *tagged*: when the subject's inferred type is `Vec[Float]`/`Vec[Int64]`, the typechecker retargets the tagged calls at the matching monomorph family, typing the element binder by the element. On linear-mem a `Vec[T]` annotation is representation-compatible with `Int` (a Vec *is* its header pointer there).

**Typed `HashMap (K, V)` families** (`hashmap.si`, linear-mem): `(i32, f32)` on the compact 12-byte slots, `(i64, i64)` on wide 24-byte slots (own probing/hash/resize/cursor), `(i32, i64)` wrapping the wide family with one sign-extension at the boundary — each with set/get/has/remove/resize + an iteration cursor. Float *keys* are deliberately unsupported (NaN ≠ NaN breaks probing — the same stance Rust takes). Coverage includes a forced i64 hash collision, tombstone re-probing, and resize bit-preservation (`hashmap-typed.test.ts`).

**First-class array accessors.** `$[…]` arrays get always-available `array::get`/`array::set`/`array::len` (no `@use`; element-typed `Int`/`Float` dispatch via typechecker retarget at the prelude `arr_*` helpers) plus `Array[T]` param/return annotations and `@loop` over `Array[T]` subjects. WASM targets only (the native backend still rejects array literals — see the QBE parity plan).

### Added — `@i64`/`@u64` casts + numeric digit separators

`@i64(x)` / `@u64(x)` cast forms close the gap flagged in the M1 entry below — `@toInt64(literal > 2³¹)` no longer truncates through `i32.const`; a 64-bit constant can now be expressed directly. Numeric literals accept `_` digit separators (`1_000_000`), grammar-neutral (lexer-level, ADR-0020 unchanged).

### Added — LSP hardened into a fuller server (18 capabilities + lifecycle)

Six new capabilities on top of the original twelve, plus protocol lifecycle: shutdown/exit, `positionEncoding` negotiation, and process-level error isolation (a handler throw answers that request with an error instead of killing the server). Also fixed M1 on-demand vec generation surfaced by LSP-driven compiles.

### Added — object-capability model v0 (K0, [ADR 0027](docs/adr/0027-capability-model-v0.md))

A minimal, WASI-aligned ocap seed — a strict subset of the deferred K1–K8 track, requiring **zero new analysis passes**: capabilities are unforgeable `@type_distinct` values rooted at `@fn main (World)` via the entry shim, attenuated by `@cap_derive` (E0017 rejects derivation from a non-root), with `World`+`Clock` proven end-to-end under wasmtime. Ships `cap.si` stdlib + `sgl.toml [build] cap-repr`.

### Added — v1.0 roadmap: closures under wasm-gc + async/event bindgen ([ADR 0018](docs/adr/0018-async-promise-ffi.md) / [ADR 0019](docs/adr/0019-first-class-closures-and-capture.md))

**C2 — closures run under `--target=wasm-gc`, engine-GC'd.** Both the non-escaping (C1) and escaping/host-callable (C2) forms now compile + run under wasm-gc with the env as a `(ref $Vec_i32)` (gc-vec.ts) instead of an i32 linear pointer — so the closure env is ENGINE-GC'd, no bump-heap retention (the linear path's documented leak).
- The C0 funcref ABI carries ref-typed params: `funcrefSigKey`/`ensureFuncrefSig` + the `FuncrefTable` signature gain `refParams`/`refResult`, so a `(ref $Vec_i32)` env is a DISTINCT call_indirect signature; the emitter builds the funcref FuncSig with `refSlot` for those positions, matching the ref-typed wrapper. All-valtype signatures stay byte-identical (non-wasm-gc unchanged).
- The closure desugar (target-threaded through `elaborate()`) types the wrapper env param + closure-holding locals + the `__closure_invoke_<k>` trampoline `clo` param `Vec[Int]` under wasm-gc; `lower.ts` pre-registers `$Vec_i32` before user lowering and gives a `Vec[Int]` `@extern` param a `(ref $Vec_i32)` slot — so an escaping closure crosses `@extern` as an engine-GC'd ref the host calls back via the trampoline. `closure-wasm-gc.test.ts` runs C1 + C2 under Bun's wasm-gc.

**Async/event host APIs via bindgen (ADR 0018 F1b / ADR 0019 C2).** The bindgen now generates the two callback-bearing surfaces the reactor + closures unlock:
- **Async** — `dtsToSpecs({ async: 'suspending' })` turns a `Promise<T>` method into a `@suspending @extern` binding whose result is the AWAITED `T` (an externref — JSString/JSValue). The `bun` module ships its async methods (`resolve`/`readableStreamTo*`/…). A program `@await`ing one drives through the production reactor — `compile()` reports the suspending MODULE call in `suspendingImports` (registry-resolved), `runWithReactor` suspends on the Promise and resumes with the externref via the JSPI fast path. (Binaryen's Asyncify can't carry externref — binaryen#3739 — so an externref async result needs JSPI, which Bun 1.3 has; the Asyncify fallback covers scalar awaited results.)
- **Event** — `dtsToSpecs({ events: 'closure' })` maps a callable (listener/callback) param to the closure-handle type `Callback`, emitted as `Vec[Int]`; the host shim wraps the handle with `closureToFn(cb)` into a JS function it registers/calls, dispatching back through the `__closure_invoke_<k>` trampoline (the C2 closure machinery). `makeClosureToFn(instance)` binds the trampolines; `event-modules.test.ts` runs the full round-trip under wasm-gc.

### Added — M1 (container monomorphization): `Vec[Float]`/`Vec[Int64]` + HashMap iteration ([ADR 0001](docs/adr/0001-generic-monomorphization-scope.md) / [ADR 0009 M-8](docs/adr/0009-wasm-gc-target.md) / [ADR 0016](docs/adr/0016-loop-over-iterables.md))

**`Vec[Float]` and `Vec[Int64]` on both targets.** Vec is now monomorphic per element type. On linear-mem (`stdlib/vec.si`): `vec_*_f32` (f32 load/store, 4-byte stride) and `vec_*_i64` (i64 load/store, 8-byte stride + `vec_new_i64`); the i32 header is element-agnostic so `vec_len`/`vec_capacity` are shared, with `vec_len_f32`/`_i64` aliases for a portable suffixed surface. Under `--target=wasm-gc` (`codegen/gc-vec.ts`, fully parameterized over element type): per-element GC arrays `$Array_f32`/`$Array_i64` + structs `$Vec_f32`/`$Vec_i64`, emitted on demand when a program uses `Vec[Float]`/`Vec[Int64]` (detected from the typed program) — the i32 emission stays byte-identical. The typechecker registers the f32/i64 vec signatures and `siliconTypeToRefIdx`/`refIdxFromAnnotation` resolve `Vec[Float]`/`Vec[Int64]` to their GC structs. The SAME suffixed source compiles + runs on both targets (`stdlib/vec-typed.test.ts`, run under Bun). Also fixed a latent bug: `WASM::i64.store` wasn't in the void-instruction set, so an i64-store-tailed function was mis-typed i32 (`lower.ts`).

**HashMap iteration** (`stdlib/hashmap.si`, ADR 0016 map iteration surface). A slot-index cursor — `hashmap_iter_start` / `hashmap_iter_next` / `hashmap_iter_done` / `hashmap_iter_key` / `hashmap_iter_value` — driven by a `while`-`@loop`, skipping empty/tombstone slots (no out-of-range probe). The first way to walk a map's entries (`hashmap.test.ts`).

Remaining M1 tail (v1.1): `HashMap[K,V]` for non-i32 keys/values, and `@loop` sugar over typed Vecs (ADR-0016-deferred — the explicit `while`-loop with `vec_len_f32`/`vec_get_f32` works today). A separate pre-existing gap surfaced: `@toInt64(literal > 2³¹)` truncates (routes through `i32.const`) — there is no Int64 literal > 2³¹ syntax yet.

### Added — v1.0 roadmap: full monomorphization (M0) + native host-handle sums (F1) ([ADR 0001](docs/adr/0001-generic-monomorphization-scope.md) / [ADR 0003](docs/comptime-via-compilation.md))

**M0 — full per-call-site monomorphization.** The compiled comptime engine gained the last primitives a memoizing `@generic` stratum needs: comptime conditionals (`@if`/`@not`/`!=`/`@nil`→0) and string `+` (routed to `compiler::str_concat`, with `str_of_int` for mixed `'n: ' + i` concatenation) in the legacy-block translator. A user-stratum inline-block handler is now compiled against the T0 handlers (which are pre-compiled before user strata register), so it can fire migrated forms. The four previously-skipped `generic-monomorph.test.ts` cases (per-call memoization: same-type sites share one monomorph, distinct types get distinct ones, the WASM runs) pass.

**The production `@fn[T]` monomorphization stratum (`src/strata/generics.si`).** HM-lite typechecks `@fn[T]` polymorphically, but codegen emitted a *single* type-erased i32 copy — so a `Float`/`Int64`/host-handle instantiation produced **invalid wasm** (an f32/i64/externref pushed at an i32 param). A T0 wildcard `on::call_site` stratum closes this additively: it probes the callee via the new `Compiler::generic_template`, and when the bindings are complete *and* include a non-i32-shaped type (`Compiler::type::needs_mono`), memoizes + pushes a specialized monomorph (`id$Float`) and rewrites the call. i32-shaped instantiations keep the erased copy untouched (zero regression). Generic-calling-generic chains specialize transitively. Call-site handlers are skipped while compiling a handler `@fn` (T0 fixpoint safety).

**F1 — native host-handle-carrying sums.** `Result[JSValue, String]` / `Option[JSValue]` now carry an externref **natively** under `--target=wasm-gc` — retiring the `js::pin` interim (which threaded a handle through `Result[Int, …]` because externref can't live in linear memory). A new pass (`src/ir/sumMono.ts`) collects every sum instantiation whose concrete type-args include a host handle and registers a **per-instantiation flat-union GC struct**: `[tag, ...flatten(each variant's resolved fields)]`, with the host-handle field typed `externref` (new `WasmGcStorageType` kind + `ref.null extern` default for unused flat-union slots). The flat-union layout gives every field its own slot, so even the *heterogeneous* `Result` (externref `Ok`, i32 `Err`) has no slot-type conflict. Constructor calls route to specialized constructors (`Ok$JSValue_String`); `@match` reads the specialized struct with per-field externref/i32 types; an externref-yielding match arm gets the `(result externref)` block type. The typechecker now **zonks** a definition's stamped node types against the reconciling substitution, so a context-resolved nullary constructor (`-> Option[JSValue]` pins `None()`'s `?T`) specializes correctly. On a linear-mem target a host-handle sum payload is a clear fail-fast error directing to `js::pin`/`--target=wasm-gc`. Tests run the modules in Bun and assert handle **identity** through the round-trip (`src/codegen/f1-host-handle-sums.test.ts`).

### Added — v1.0 roadmap: async productization + leak-free closure codegen ([ADR 0018](docs/adr/0018-async-promise-ffi.md) / [ADR 0019](docs/adr/0019-first-class-closures-and-capture.md))

**F1b — the `@async`/`@await`/`@suspending` surface + production reactor (ADR 0018 P2/P3-routeB/P5/Phase-2).** The Asyncify transform and host reactor shipped earlier; this productizes them.
- **`@async` / `@suspending` markers** — signature-line modifiers (no grammar change): `\\ @async f (…) -> …` colors a function; `\\ @suspending @extern http::get (…)` marks a Promise-returning import. The coloring typecheck rule (**E0016**) rejects `@await` outside an `@async` body; the color is inherited by nested `@local` bindings.
- **Production reactor** (`runWithReactor`, `compiler/src/codegen/async-reactor.ts`) — chooses the backend at LOAD time from one vanilla binary: the **JSPI fast path** (`WebAssembly.Suspending`/`promising`) where the engine has it — **Bun 1.3.14 now ships JSPI** (`bun#20878` resolved) — else **Asyncify route-B** precise coloring (`applyAsyncify({ suspendingImports })`, instrumenting only functions that can reach a suspending import). Both backends run the SAME source; verified end-to-end on Bun.
- **`sgl run` wiring** — `runUnderBun` threads `result.suspendingImports` and drives a `@suspending`-using program through the reactor instead of a one-shot `_start`; `compile()` reports `suspendingImports` (`module.field`). The async host APIs (`fetch`/timers) that feed it are the FFI async-binding layer.

**C2 — leak-free wasm-gc closure representation, codegen core (ADR 0019 §2.2).** The escaping closure's env must cross `@extern` as an `externref`-boxed GC ref so the engine traces it (collected when the host drops it — no bump-heap leak). The three primitives ADR 0019 named "absent today" are now implemented + proven:
- New IR nodes + binary/WAT emitters: **`ExternConvertAny`** (`extern.convert_any`, 0xFB 0x1B — box), **`AnyConvertExtern`** (`any.convert_extern`, 0xFB 0x1A — unbox), **`RefCast`** (`ref.cast (ref $T)`, 0xFB 0x16 — narrow).
- `gc-closure-box.test.ts` builds a module through Silicon's real emitter that boxes a GC env array as `externref`, hands it to the host, and reads it back via unbox + `ref.cast` + `array.get` — running under Bun, the handle crosses as a real engine reference (not an i32), engine-GC'd.
- Remaining integration: auto-routing `@export_callback` to this under `--target=wasm-gc` needs the closure wrapper/`@call_indirect` to carry a ref-typed `(ref $Vec_i32)` env param (today hardcoded `Int`, so closures are linear-only under wasm-gc) — a C0 funcref-ABI extension.

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

### Added — v1.0 roadmap: constructed Web interface modules ([ADR 0017](docs/adr/0017-ffi-binding-generator.md) / [ADR 0018](docs/adr/0018-async-promise-ffi.md))

Five real Web interfaces are now generated as Tier-2 built-in modules from the
`@webref/idl` corpus — the FFI surface's first *constructed objects* (not just
free functions): **`url`**, **`url_search_params`**, **`headers`**,
**`text_encoder`**, **`text_decoder`**.

- **A new `webiface` adapter** turns one Web IDL interface into a module. Because
  Silicon has no methods or `.`-syntax (ADR-0023), each instance member becomes a
  free function whose FIRST argument is the receiver — a `JSValue` externref
  handle: `new URL(s)` → `url::create(s)`, `url.pathname` → `url::pathname(h)`,
  `headers.append(k,v)` → `headers::append(h, k, v)`. It binds all six shapes:
  **constructor** (`new Iface(args)` → JSValue), **instance method**
  (`recv.m(rest)`), **getter** (`recv.attr`), **setter** (`recv.attr = v`),
  **static** (`Iface.m(args)`), and IDL **stringifier** (`recv.toString()` →
  `to_string`).
- **Cross-handle threading** — a handle produced by one interface flows into
  another, entirely as externref with no marshalling: `url::search_params(url)`
  returns a `URLSearchParams` handle consumed by `url_search_params::get`;
  `text_encoder::encode` returns a `Uint8Array` handle consumed by
  `text_decoder::decode` (a verified multibyte UTF-8 round-trip).
- **Type rule**: scalars via `idlTypeToSi`; interfaces and ambient JS object/
  buffer types (Uint8Array, BufferSource, …) → `JSValue`; **dictionaries are NOT
  handles** (an optional dict arg is dropped, a required one skips the member);
  a union with a string arm binds as `String`.
- **Optional-arg policy** (Silicon has no optional params, and a `""` string ≠
  "omitted"): keep required args; keep the FIRST optional only when it is the
  payload (no required arg precedes it — `encode(input)`, `new URLSearchParams(init)`);
  DROP a secondary optional (`URL.canParse`'s base, `URLSearchParams.has`/`delete`'s
  value) so the correct 1-arg WHATWG form is exposed rather than a forced arg that
  silently mis-answers.
- **Nullable externref results.** An object-handle import that can return `null`
  (`Headers.get` of a missing header, `URL.parse` of an invalid URL) now lowers to
  a NULLABLE `externref` result (`lower.ts`, both the module-call and bare-`@extern`
  paths) — previously every externref result was non-null `(ref extern)` and
  trapped on `null`. `wasm:js-string` builtin results stay non-null per spec.
- Two adversarial-review-confirmed bug classes (forced-optional wrong answers,
  null-return traps) fixed before merge. `externref-shapes.test.ts` proves all
  seven binding shapes compile AND run under Bun; `web-interfaces.test.ts` runs
  the five modules end-to-end including a missing-key `null` result and the
  `encode → Uint8Array handle → decode` round-trip.

### Added — v1.0 roadmap: spec-driven FFI modules + Tier-2 object handles ([ADR 0017](docs/adr/0017-ffi-binding-generator.md) / [ADR 0018](docs/adr/0018-async-promise-ffi.md))

Broadens the FFI surface from the single Web `Math`/clock fragment to whole
spec-generated built-in modules, across all three boundary tiers.

- **Every adapter is spec-driven.** Web from the real `@webref/idl` corpus (via
  `webidl2`), Node + Bun from their real `.d.ts` (`@types/node`, `bun-types`) via
  the TypeScript compiler API. A `BindingSpec` is generated per callable export
  whose resolved signature is bindable; everything else is logged, never silently
  dropped. `bun bindgen/cli.ts --report` prints per-source coverage.
- **Generated built-in modules.** A namespace becomes its own
  `compiler/src/strata/modules/<mod>.si` (auto-bundled, callable as `mod::fn`) plus
  a marshalling host shim spliced into `js-host.ts`: **`path`** + **`os`** (Node,
  Tier-0 linear `String`), **`bun`** (Tier-1), **`json`** (Tier-2). One IR, three
  emitters, byte-for-byte enforced by `--check` in CI.
- **Tier-1 — `JSString`.** A module marked `strings: 'jsstring'` emits `String` as
  `JSString` (an engine-native externref); the host passes JS strings DIRECTLY with
  zero linear-memory marshalling (`bun::strip_ansi`, web/bun only).
- **Tier-2 — `JSValue` object handles.** A new `objects: 'jsvalue'` adapter mode
  maps a plain object/array type to the opaque externref handle `JSValue` (callables
  and Promises are deliberately *not* handles). `json::parse` returns a `JSValue`;
  `json::stringify` takes one back — a host object round-trips through guest code as
  an engine-GC'd externref with no marshalling and no manual release. The compiler
  already lowers `JSValue` to a nullable `externref` (F1a), web/bun-gated.
- **Optional-arg widening.** An unrepresentable *optional* (`?`) param (e.g. a JSON
  `reviver` callback) is dropped so the common-case call still binds, instead of
  rejecting the whole binding; a *variadic rest* (`...args`) param still skips the
  binding (no silent wrong-arity call). This alone added `bun::open_in_editor`,
  `random_uuidv7`, `string_width`, `which`, `wrap_ansi`, `slice_ansi`.

### Added — v1.0 roadmap Phase 4 core: the poll-reactor ([ADR 0018](docs/adr/0018-async-promise-ffi.md) P4 / ADR 0019 C3)

Delivered on the `phase-4-poll-reactor` branch. The final critical-path mechanism
toward true concurrency — and the payoff of the closures keystone.

- **`stdlib/future.si`** — a *future* is a no-arg closure (C1) over a mutable
  poll-state pointer that returns `future_pending()` until ready, then a value.
  `block_on` drives one future to completion; **`block_all` drives MANY futures
  concurrently** — each round polls every still-pending future, so independent
  futures progress *interleaved* (the true-concurrency model single-in-flight
  Asyncify cannot express). Futures are closures, so a wake continuation closes
  over the awaiting state — the reason this waited on C1/C2.
- `future.test.ts` runs real WASM: `block_on` (single), `block_all` over three
  futures with deadlines 2/4/3 (→ 60, polled interleaved), and fast+slow
  independent progress (→ 107).
- Remaining: the generic `Poll[T] := $Pending | $Ready value T` sum (removes the
  negative-sentinel constraint) and host-async integration (a future backed by a
  real Promise, woken by the F1b reactor).

### Added — v1.0 roadmap Phase 3 core: blocking `@await` (Asyncify, [ADR 0018](docs/adr/0018-async-promise-ffi.md))

Delivered on the `phase-3-async-await` branch.

- **`@await(expr)`** — a suspension-point surface stratum (`control.si`); transparent
  (lowers to its argument) and typed to its argument's type. The route-A Asyncify
  transform makes the suspension automatic at the host-async import call.
- **Asyncify transform** (`codegen/asyncify.ts`, `applyAsyncify`) — runs Binaryen's
  `asyncify` pass over the emitted binary, instrumenting the unwind/rewind state
  machine so a synchronous-looking guest can suspend on any engine (V8/JSC/Bun/
  native) with no host async feature — the permanent floor while JSPI is absent on
  JSC/Bun.
- **Async host reactor** (`codegen/async-reactor.ts`, `createAsyncReactor`) — wraps
  host-async imports and drives the unwind → await → rewind loop (single-in-flight;
  the asyncify stack lives in a reserved memory page). Verified end-to-end under
  Bun (`asyncify.test.ts`): a Silicon `@fn` `@await`s host-async imports and resumes
  correctly, including a two-suspension chain. ADR 0018 Accepted.
  Remaining: the `@async`/`@suspending` coloring, precise-coloring route B, the
  production `sgl run` reactor, and the JSPI fast path.

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
