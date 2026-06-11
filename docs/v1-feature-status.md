# Silicon v1 — feature status

> **As of:** branch `v1-roadmap` (`eb0f995` — M0 full monomorphization, F1 native
> host-handle sums, and the v0 capability model landed). Statuses **re-verified
> against the actual code + tests** this revision (a 6-cluster sweep; code beats the
> doc where they disagreed — `@global`/`@local`/`@struct` retired, code-action API +
> playground + the incremental front-end found already shipped).
> **Companion:** [`v1.0-implementation-roadmap.html`](v1.0-implementation-roadmap.html)
> (critical-path detail), [`ffi-coverage-gaps.md`](ffi-coverage-gaps.md) (FFI),
> the per-feature ADRs under [`adr/`](adr/).
>
> Legend: ✅ shipped · 🟡 partial (shipped, scoped limit) · ⏳ v1.1 · 🔜 post-v1.0 (by design).

## Headline

**The v1.0 gate is closed.** FFI coverage, closures (C0–C2), async (F1b + the F3
poll-reactor), and full monomorphization (M0 — per-call-site memoization + the
production `@generic`/`@fn[T]` stratum) are shipped. Native host-handle-carrying
sums (`Result[JSValue, String]` under `--target=wasm-gc`) ride that
monomorphization substrate, retiring the `js::pin` interim. A **minimal
WASI-aligned object-capability model (K0, ADR 0027)** shipped on top — caps are
unforgeable values rooted at `@fn main (World)`. The *full* capability/borrow
track (K1–K8) and container monomorphization (M1) are the *deliberately* deferred
post-gate work.

## The planned critical path (FFI gate · async/closures · mono · capability)

| # | Feature | Status | Notes |
|---|---|:--:|---|
| **F0a** | Bindgen (generate `@extern` + host shims from WebIDL/`.d.ts`) | ✅ | anti-drift, CI-gated; Tier-0/1/2 + async + event modes |
| **F1a** | Object handles / `JSValue` externref | ✅ | the generic host-object handle type |
| **F1b** | Blocking `@await` + reactor + `@async`/`@suspending` | ✅ | JSPI + Asyncify dual-backend; `E0016` coloring |
| **F3-opt** | JSPI fast path | ✅ | shipped *inside* the reactor (feature-detected) |
| **F3** | Poll-reactor + tasks (`Poll[T]`, `spawn`/`block_on`) | ✅ | + `future_async.si` Promise bridge |
| **C0** | Generalized funcref ABI (multi-signature table) | ✅ | byte-equal codegen for the i32→i32 case |
| **C1** | Non-escaping closures (all modes) | ✅ | by-value / i32 capture; Float captures + zero-cost direct-call form are refinements on top |
| **C2** | Escaping host-callable closures — **THE GATE** | ✅ | leak-free under `--target=wasm-gc`; linear-mem retains env in bump heap |
| **FFI 100% gate** | every host member binds | 🟡 | **99.74%** (379/380) — only `Bun.$` (a tagged-template) unbound; plan committed |
| **M0** | Comptime monomorphization (full) | ✅ | per-call-site memoization + the production `@generic` stratum shipped; the all-i32 erased copy serves i32-shaped calls, Float/Int64/host-handle calls get a specialized monomorph. User-facing generics: `@fn[T]`/`@type[T]` HM-lite. Native `Result[JSValue,E]` rides this (see FFI F1) |
| **M1** | Container mono `Vec[T]` / `HashMap[K,V]` | 🟡 | **`Vec[Float]`/`Vec[Int64]` ship on BOTH targets** (linear-mem `vec_*_f32`/`_i64`; wasm-gc per-element `$Array_f32`/`$Array_i64` from the parameterized `gc-vec.ts`) + a **HashMap iteration** cursor surface. The remaining tail: `HashMap[K,V]` for non-i32 keys/values, and `@loop` sugar over typed Vecs (ADR-0016-deferred) |
| **K0** | Object-capability model **v0** (minimal, WASI-aligned) | ✅ | ADR 0027: unforgeable `@type_distinct` caps, rooted at `@fn main (World)` via the entry shim, attenuated by `@cap_derive` (E0017 "downgrade-from-root"); `World`+`Clock` proven e2e under wasmtime. Zero new analysis pass — a strict subset of ADR 0015 / K1–K8 |
| **K1–K8** | Full capability/borrow track (`on::check`, reflection, fixpoint checker, `@capability` seal, rcaps) | 🔜 | post-v1.0; K0 (above) is the seed it builds on without rework |

## The broader v1 surface (shipped)

| Area | Shipped |
|---|---|
| **Language / grammar** | Strata 2.0 (features-as-Silicon-source), Odin grammar (ADR-0020: bare defs, always-parens calls, dropped `&` sigil), conservative ASI (ADR-0026), bare `name := v` (immutable) / `@mut name := v` (mutable) bindings, `@type P := { x Int, y Int }` records (`@struct`/`@global`/`@local` **retired** by ADR-0020), `@enum`, flat `@match`, `@defer`, `@try`, first-class fn refs + `call_indirect`, `@loop` over iterables (range + indexed-`Vec`, syntactic dispatch) |
| **Type system** | HM-lite inference, `@fn[T]`/`@type[T]` generics, sum types + parametric `Option[T]`/`Result[T,E]`, `Int`/`Int32`/`Int64` hierarchy, unsigned `u8`–`u64`, `Slice[T]`, `@type_alias`/`@type_distinct` |
| **Stdlib** | `Option`/`Result`, `Vec[T]` (`Int`/`Float`/`Int64`, both targets — M1), `HashMap[i32,i32]` + **iteration cursor**, `Rc<T>`, `io`, `future`/`future_async`, `ffi` (host-error→`Result`), string byte-views + `StrBuilder` (ADR-0022). `Result[JSValue,E]`/`Option[JSValue]` carry a host handle **natively** under `--target=wasm-gc` (no `js::pin`) |
| **FFI / host** | bindgen (3 tiers), `js` module (object/array/handle substrate), `stream` module, generated modules (`path`/`os`/`json`/`bun`/`url`/fetch ecosystem/`event_target`/`crypto`/`fs`/`global`), `promise` concurrency, no fundamental classifier gaps |
| **Backends** | WAT/WASM (binaryen+wabt), QBE → native (Tier-1: linux/macos x86_64+arm64), `--target=wasm-gc` (engine-GC structs/sums) |
| **Memory** | arena `with_arena`/parent-escape, clean heap-exhaustion trap + `--max-heap=N`, `heap_used`/`arena_used`, published `allocator.wit` |
| **Tooling / CaaS** | red-green syntax tree, `SemanticModel`, `Workspace`, symbol API, **code-action API** (CaaS-11, 1.0-stable), **incremental reparse/elaborate/typecheck** (wired into `Workspace`/LSP), diagnostics-as-data, `sgl init/build/run/check/fmt` + `--release`, a **runnable LSP server** (12 handlers incl. cross-file goto + completion), a **deployable client-side playground** (`playground/dist`), distribution (Releases/Homebrew/apt/winget/installer), docs set + 27 ADRs |
| **Capabilities** | object-capability model **v0** (ADR 0027): unforgeable `@type_distinct` caps (`World`/`Clock`), rooted at `@fn main (World)` via the entry shim, attenuated by `@cap_derive` (E0017); `cap.si` stdlib + `sgl.toml [build] cap-repr` |

## Deferred — v1.1 / post-v1.0

| Feature | When | Note |
|---|:--:|---|
| `HashMap[K,V]` for non-i32 keys/values — M1 tail | ⏳ v1.1 | `Vec[Float]`/`Vec[Int64]` + HashMap iteration **shipped** (M1); non-i32 (K,V) mono + `@loop` over typed Vecs remain |
| Heterogeneous host-handle sums on **linear-mem** target | 🔜 | native on `--target=wasm-gc` (✅); on a linear-mem target externref isn't addressable → `E` fail-fast directing to `js::pin`/wasm-gc |
| `IterStep[T,R]` user iteration protocol (ADR-0016) | ⏳ v1.1 | range/`Vec` dispatch ships; structural dispatch waits on reflection + combinators |
| LSP server | 🟡 | a runnable stdio server, now **18 capabilities** — added declaration, typeDefinition, documentHighlight, rangeFormatting, workspace/symbol, prepareRename + lifecycle (shutdown/exit, positionEncoding, process-level error isolation). Remaining tail: cross-file **diagnostic** invalidation (needs Workspace open-doc dep resolution + incremental dependency tracking) and binding-identity (S1, `containingSymbol`) for scope-correct rename/references |
| Incremental compilation — codegen + hardening | 🟡 | incremental reparse + elaborate + typecheck shipped & wired into `Workspace`/LSP (43 tests); incremental **codegen** is the v1.1 remainder |
| Package registry (registry-backed `sgl add`) | ⏳ v1.1 | `--path` local deps work today; the registry server is pending (story 6b-12) |
| Silicon-native comptime interpreter | 🔜 | comptime runs on the host today (ADR-0003 pivot) |
| Full capability/borrow track — fixpoint checker, borrow checker, effect-class optimization (K1–K8) | 🔜 post-v1 | ADR 0011/0012/0013/0015; the minimal ocap **v0** seed shipped (ADR 0027 — see K0) |
| `Bun.$` tagged-template binding | 🔜 | the one FFI skip; security-driven plan ([`bun-shell-ffi-plan.md`](bun-shell-ffi-plan.md)) |

## Note — M0 completed + F1 (native host-handle sums) landed

M0 is now **fully wired**, not just substrate-complete. Two pieces shipped on
top of the substrate:

1. **Full per-call-site monomorphization.** The compiled comptime engine gained
   conditionals (`@if`/`@not`/`!=`/`@nil`) and string `+` (`compiler::str_concat`),
   so a memoized `@generic` stratum (`@if(@not(state::has(monoKey)))`) emits one
   monomorph per (template, type-args) and same-typed call sites share it. The
   four previously-skipped `generic-monomorph.test.ts` cases pass.
2. **The production `@fn[T]` stratum** (`src/strata/generics.si`). HM-lite checks
   `@fn[T]` polymorphically but codegen emitted a single type-erased i32 copy —
   a `Float`/`Int64`/host-handle instantiation produced *invalid wasm*. The
   stratum additively specializes those call sites (the i32-shaped erased copy
   is untouched, so zero regression).

**F1 — native host-handle-carrying sums.** Riding the same machinery,
`Result[JSValue, String]` / `Option[JSValue]` now carry an externref **natively**
under `--target=wasm-gc`: a per-instantiation flat-union GC struct types the
host-handle field as `externref` (the heterogeneous `Result` — externref `Ok`,
i32 `Err` — works because the flat-union layout gives every field its own slot).
On a linear-mem target it's a clean fail-fast error (externref isn't addressable
in linear memory) directing to `js::pin`/wasm-gc. This retires the `js::pin`
interim for the wasm-gc path.
