# Silicon v1 — feature status

> **As of:** branch `v1-roadmap` (M0 full monomorphization + F1 native host-handle
> sums landed). Verified against the roadmap, all 26 ADRs, the CHANGELOG, and the
> actual code/tests on this branch (code beats memory where they disagree).
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
monomorphization substrate, retiring the `js::pin` interim. The
capability/borrow-checker model and container monomorphization (M1) are the
*deliberately* deferred post-gate work.

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
| **M1** | Container mono `Vec[T]` / `HashMap[K,V]` | ⏳ | works **i32-only** today; element-type/(K,V) mono + HashMap iteration is v1.1 (the "dominant speed lever") |
| **K1–K8** | Capability model + borrow checker (`on::check`, reflection, `@capability`, rcaps) | 🔜 | **zero code by design** — post-v1.0; v1.0 closures need no borrow checker |

## The broader v1 surface (shipped)

| Area | Shipped |
|---|---|
| **Language / grammar** | Strata 2.0 (features-as-Silicon-source), Odin grammar (ADR-0020: bare defs, always-parens calls, dropped `&` sigil), conservative ASI, `@global`/`@local` bindings, `@struct`, `@enum`, flat `@match`, `@defer`, `@try`, first-class fn refs + `call_indirect`, `@loop` over iterables (range + indexed-`Vec`, syntactic dispatch) |
| **Type system** | HM-lite inference, `@fn[T]`/`@type[T]` generics, sum types + parametric `Option[T]`/`Result[T,E]`, `Int`/`Int32`/`Int64` hierarchy, unsigned `u8`–`u64`, `Slice[T]`, `@type_alias`/`@type_distinct` |
| **Stdlib** | `Option`/`Result`, `Vec[T]` (i32), `HashMap[i32,i32]`, `Rc<T>`, `io`, `future`/`future_async`, `ffi` (host-error→`Result`), string byte-views + `StrBuilder` (ADR-0022). `Result[JSValue,E]`/`Option[JSValue]` carry a host handle **natively** under `--target=wasm-gc` (no `js::pin`) |
| **FFI / host** | bindgen (3 tiers), `js` module (object/array/handle substrate), `stream` module, generated modules (`path`/`os`/`json`/`bun`/`url`/fetch ecosystem/`event_target`/`crypto`/`fs`/`global`), `promise` concurrency, no fundamental classifier gaps |
| **Backends** | WAT/WASM (binaryen+wabt), QBE → native (Tier-1: linux/macos x86_64+arm64), `--target=wasm-gc` (engine-GC structs/sums) |
| **Memory** | arena `with_arena`/parent-escape, clean heap-exhaustion trap + `--max-heap=N`, `heap_used`/`arena_used`, published `allocator.wit` |
| **Tooling / CaaS** | red-green syntax tree, `SemanticModel`, `Workspace`, symbol API, diagnostics-as-data, `sgl init/build/run/check/fmt` + `--release`, distribution (Releases/Homebrew/apt/winget/installer), docs set + 26 ADRs |

## Deferred — v1.1 / post-v1.0

| Feature | When | Note |
|---|:--:|---|
| Container mono (`Vec[Float]`/`Vec[Int64]`, HashMap iteration) — M1 | ⏳ v1.1 | i32-only today |
| Heterogeneous host-handle sums on **linear-mem** target | 🔜 | native on `--target=wasm-gc` (✅); on a linear-mem target externref isn't addressable → `E` fail-fast directing to `js::pin`/wasm-gc |
| `IterStep[T,R]` user iteration protocol (ADR-0016) | ⏳ v1.1 | range/`Vec` dispatch ships; structural dispatch waits on reflection + combinators |
| LSP server | ⏳ v1.1 | CaaS foundation shipped; cross-file goto + completion **already landed on this branch**; full server is v1.1 |
| Package registry, incremental compilation, code-action API, playground | ⏳ v1.1 | CaaS-7/8/11 stories |
| Silicon-native comptime interpreter | 🔜 | comptime runs on the host today (ADR-0003 pivot) |
| Capability model + borrow checker + ocaps + effect-class optimization (K1–K8) | 🔜 post-v1 | ADR 0011/0012/0013/0015 |
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
