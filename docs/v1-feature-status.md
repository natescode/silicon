# Silicon v1 — feature status

> **Released:** this surface shipped as **v0.2.0** (2026-06-12, `v1-roadmap`
> merged to `main`). The **1.0 version number is deliberately reserved** for
> the post-bootstrap fixpoint (self-hosted compiler, QBE backend at WASM
> parity, eternal grammar locked only after self-hosting stress-tests the
> language). Next: the bootstrap — see
> [`bootstrap-blockers-and-order.md`](bootstrap-blockers-and-order.md) and
> [`bootstrap-foundation-audit.md`](bootstrap-foundation-audit.md).
>
> **As of:** branch `v1-roadmap` (LSP tail **closed** — cross-file diagnostic
> invalidation + S1 binding identity — and the FFI gate declared **100%\***
> with `Bun.$` officially excluded; previously M1 container monomorphization
> completed on top of `96a7307`). Statuses **re-verified against the actual
> code + tests** two revisions back (a 6-cluster sweep; code beats the doc
> where they disagreed — `@global`/`@local`/`@struct` retired, code-action API
> + playground + the incremental front-end found already shipped).
> **Companion:** [`v1.0-implementation-roadmap.html`](v1.0-implementation-roadmap.html)
> (critical-path detail), [`ffi-coverage-gaps.md`](ffi-coverage-gaps.md) (FFI),
> the per-feature ADRs under [`adr/`](adr/).
>
> Legend: ✅ shipped · 🟡 partial (shipped, scoped limit) · ⏳ v1.1 · 🔜 post-v1.0 (by design).

## Headline

**The v1.0 gate is closed.** FFI coverage (**100%\*** — every bindable host
member binds; `Bun.$` officially excluded as a JS syntactic form), closures
(C0–C2), async (F1b + the F3 poll-reactor), and full monomorphization (M0 —
per-call-site memoization + the production `@generic`/`@fn[T]` stratum) are
shipped. Native host-handle-carrying
sums (`Result[JSValue, String]` under `--target=wasm-gc`) ride that
monomorphization substrate, retiring the `js::pin` interim. A **minimal
WASI-aligned object-capability model (K0, ADR 0027)** shipped on top — caps are
unforgeable values rooted at `@fn main (World)`. **Container monomorphization
(M1) is now complete** — typed Vecs (`Float`/`Int64`, both targets) with
`@loop` element-typed iteration, plus typed HashMap (K, V) families with an
iteration-cursor surface. The *full* capability/borrow track (K1–K8) is the
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
| **FFI 100% gate** | every host member binds | ✅ | **100%\*** (379/379 bindable members). The asterisk: `Bun.$` is **officially excluded by policy** — a tagged template is a JS *syntactic form*, not a callable member; binding it as a normal fn would destroy its per-substitution shell-escaping guarantee. CI-enforced skip list of exactly `['Bun.$']` (`bindgen/adapters.test.ts`); the honest `js::tagged`+`shell.si` path stays optional post-v1.0 ([`bun-shell-ffi-plan.md`](bun-shell-ffi-plan.md)) |
| **M0** | Comptime monomorphization (full) | ✅ | per-call-site memoization + the production `@generic` stratum shipped; the all-i32 erased copy serves i32-shaped calls, Float/Int64/host-handle calls get a specialized monomorph. User-facing generics: `@fn[T]`/`@type[T]` HM-lite. Native `Result[JSValue,E]` rides this (see FFI F1) |
| **M1** | Container mono `Vec[T]` / `HashMap[K,V]` | ✅ | **`Vec[Float]`/`Vec[Int64]` ship on BOTH targets** (linear-mem `vec_*_f32`/`_i64`; wasm-gc per-element `$Array_f32`/`$Array_i64` from the parameterized `gc-vec.ts`). **`@loop` over typed Vecs**: the desugared `vec_len`/`vec_get_i32` calls are tagged and retargeted by the typechecker at the subject's monomorph family, so the binder is element-typed (both targets; on linear-mem a `Vec[T]` annotation is representation-compatible with `Int`). **Typed HashMap (K, V) families** (linear-mem, like the i32 base): `(i32,f32)` on the compact 12-byte slots, `(i64,i64)` on wide 24-byte slots, `(i32,i64)` wrappers — each with set/get/has/remove/resize + an **iteration cursor** (`hashmap_iter_*`, compact + `_i64` wide + `_f32` value reads). Float *keys* deliberately unsupported (NaN); struct-element Vecs and ref-typed elements are the v1.1 runway (ADR 0009 §3) |
| **K0** | Object-capability model **v0** (minimal, WASI-aligned) | ✅ | ADR 0027: unforgeable `@type_distinct` caps, rooted at `@fn main (World)` via the entry shim, attenuated by `@cap_derive` (E0017 "downgrade-from-root"); `World`+`Clock` proven e2e under wasmtime. Zero new analysis pass — a strict subset of ADR 0015 / K1–K8 |
| **K1–K8** | Full capability/borrow track (`on::check`, reflection, fixpoint checker, `@capability` seal, rcaps) | 🔜 | post-v1.0; K0 (above) is the seed it builds on without rework |

## The broader v1 surface (shipped)

| Area | Shipped |
|---|---|
| **Language / grammar** | Strata 2.0 (features-as-Silicon-source), Odin grammar (ADR-0020: bare defs, always-parens calls, dropped `&` sigil), conservative ASI (ADR-0026), bare `name := v` (immutable) / `@mut name := v` (mutable) bindings, `@type P := { x Int, y Int }` records (`@struct`/`@global`/`@local` **retired** by ADR-0020), `@enum`, flat `@match`, `@defer`, `@try`, first-class fn refs + `call_indirect`, `@loop` over iterables (range + indexed-`Vec` — incl. element-typed `Vec[Float]`/`Vec[Int64]` via the M1 typecheck retarget — and indexed-`Array[T]` subjects via the same retarget at the prelude `arr_*` helpers), `$[…]` array accessors `array::get`/`array::set`/`array::len` (always available, element-typed `Int`/`Float` dispatch, no `@use`) + `Array[T]` param/return annotations |
| **Type system** | HM-lite inference, `@fn[T]`/`@type[T]` generics, sum types + parametric `Option[T]`/`Result[T,E]`, `Int`/`Int32`/`Int64` hierarchy, unsigned `u8`–`u64`, `Slice[T]`, `@type_alias`/`@type_distinct` |
| **Stdlib** | `Option`/`Result`, `Vec[T]` (`Int`/`Float`/`Int64`, both targets — M1), `HashMap[K,V]` monomorph families (`(i32,i32)`, `(i32,f32)`, `(i32,i64)`, `(i64,i64)`) + **iteration cursors** (compact + wide — M1), `Rc<T>`, `io`, `future`/`future_async`, `ffi` (host-error→`Result`), string byte-views + `StrBuilder` (ADR-0022). `Result[JSValue,E]`/`Option[JSValue]` carry a host handle **natively** under `--target=wasm-gc` (no `js::pin`) |
| **FFI / host** | bindgen (3 tiers), `js` module (object/array/handle substrate), `stream` module, generated modules (`path`/`os`/`json`/`bun`/`url`/fetch ecosystem/`event_target`/`crypto`/`fs`/`global`), `promise` concurrency, no fundamental classifier gaps |
| **Backends** | WAT/WASM (binaryen+wabt), QBE → native (Tier-1: linux/macos x86_64+arm64), `--target=wasm-gc` (engine-GC structs/sums) |
| **Memory** | arena `with_arena`/parent-escape, clean heap-exhaustion trap + `--max-heap=N`, `heap_used`/`arena_used`, published `allocator.wit` |
| **Tooling / CaaS** | red-green syntax tree, `SemanticModel`, `Workspace`, symbol API, **code-action API** (CaaS-11, 1.0-stable), **incremental reparse/elaborate/typecheck** (wired into `Workspace`/LSP), diagnostics-as-data, `sgl init/build/run/check/fmt` + `--release`, a **runnable LSP server** (12 handlers incl. cross-file goto + completion), a **deployable client-side playground** (`playground/dist`), distribution (Releases/Homebrew/apt/winget/installer), docs set + 27 ADRs |
| **Capabilities** | object-capability model **v0** (ADR 0027): unforgeable `@type_distinct` caps (`World`/`Clock`), rooted at `@fn main (World)` via the entry shim, attenuated by `@cap_derive` (E0017); `cap.si` stdlib + `sgl.toml [build] cap-repr` |

## Deferred — v1.1 / post-v1.0

| Feature | When | Note |
|---|:--:|---|
| Ref-/struct-typed container elements; HashMap on wasm-gc | ⏳ v1.1 | **M1 is complete** (typed Vecs + `@loop` dispatch + typed HashMap families). The runway beyond it: `Vec[T]` over by-value structs / managed refs (ADR 0009 §3), a managed-substrate HashMap for wasm-gc (today's is linear-mem `alloc`, E0013 there), and float keys (deliberately unsupported — NaN) |
| Heterogeneous host-handle sums on **linear-mem** target | 🔜 | native on `--target=wasm-gc` (✅); on a linear-mem target externref isn't addressable → `E` fail-fast directing to `js::pin`/wasm-gc |
| `IterStep[T,R]` user iteration protocol (ADR-0016) | ⏳ v1.1 | range/`Vec` dispatch ships; structural dispatch waits on reflection + combinators |
| LSP server | ✅ | a runnable stdio server, **18 capabilities** + lifecycle (shutdown/exit, positionEncoding, process-level error isolation). The two former tail items are **done**: **cross-file diagnostic invalidation** (`Workspace.refreshDependents` — signature-driven, no dep graph: a doc re-checks exactly when its visible external-symbol surface changed; the LSP republishes the refreshed docs) and **binding identity** (S1 — `ast/binder.ts` assigns every local occurrence to its concrete binding; `containingSymbol` populated for params/locals/pattern fields; rename/references are scope-correct: a param `x` never renames another `x`, a top-level rename skips shadowed locals) |
| Incremental compilation — codegen + hardening | 🟡 | incremental reparse + elaborate + typecheck shipped & wired into `Workspace`/LSP (43 tests); incremental **codegen** is the v1.1 remainder |
| Package registry (registry-backed `sgl add`) | ⏳ v1.1 | `--path` local deps work today; the registry server is pending (story 6b-12) |
| Silicon-native comptime interpreter | 🔜 | comptime runs on the host today (ADR-0003 pivot) |
| Full capability/borrow track — fixpoint checker, borrow checker, effect-class optimization (K1–K8) | 🔜 post-v1 | ADR 0011/0012/0013/0015; the minimal ocap **v0** seed shipped (ADR 0027 — see K0) |
| `Bun.$` tagged-template binding | 🔜 | **officially excluded from the v1.0 gate** (the `100%*` asterisk — a JS syntactic form, not a callable member); the optional security-driven plan is [`bun-shell-ffi-plan.md`](bun-shell-ffi-plan.md) |

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

## Note — M1 completed (container monomorphization)

The two documented tails landed, closing M1:

1. **`@loop` over typed Vecs.** The iterate-`@loop` desugar runs pre-typecheck,
   so it emits the i32-default `vec_len`/`vec_get_i32` — now *tagged*. When the
   subject's inferred type is `Vec[Float]`/`Vec[Int64]`, the typechecker
   retargets the tagged calls at the matching monomorph family
   (`vec_get_f32`/`_i64`, …), typing the element binder by the element. Works
   on **both targets**: under wasm-gc the tagged synthetic subject local is
   ref-typed from its *inferred* type (`lower.ts` previously needed an
   annotation), and on linear-mem a `Vec[T]` annotation is now
   representation-compatible with `Int` (a Vec *is* its header pointer there) —
   which also made the pre-existing `vec-typed.test.ts` annotations typecheck
   *clean* on host instead of relying on unchecked diagnostics.
2. **Typed HashMap (K, V) families** (`hashmap.si`, linear-mem like the i32
   base): `(i32, f32)` rides the compact 12-byte slots (f32 is 4 bytes — shares
   new/has/remove/resize/cursor; rehash copies value bits raw), `(i64, i64)` is
   a wide 24-byte-slot family (i64 probing/hash, resize, remove, own
   `hashmap_iter_*_i64` cursor), `(i32, i64)` wraps the wide family with a
   single sign-extension at the boundary. Float *keys* are deliberately
   unsupported (NaN ≠ NaN breaks probing) — the same stance Rust takes.

Coverage: `src/e2e/loop-iterables.test.ts` (typed-Vec loops, both targets) +
`src/stdlib/hashmap-typed.test.ts` (all three families end-to-end, including a
forced i64 hash collision, tombstone re-probing, and resize bit-preservation).

## Note — LSP tail closed (cross-file diagnostics + S1) and FFI declared 100%\*

The last two LSP tail items landed, and the FFI gate's one skip became an
official policy exclusion:

1. **Cross-file diagnostic invalidation.** `Workspace.refreshDocument` /
   `refreshDependents` (CaaS) re-check an open document **without an edit**
   when the external symbols it sees changed.  Invalidation is
   *signature-driven*, not graph-driven: each compile stores the
   `externalSymbolsSignature` it ran against, and a document re-checks exactly
   when its visible surface differs — project scoping folds in for free, a
   body-only edit elsewhere invalidates nothing, and there is no `@use`
   dependency graph to keep correct.  Runs to a fixpoint (a refresh can change
   the refreshed doc's own exports).  The LSP diagnostics handler republishes
   every refreshed document, so renaming `@fn add` in `lib.si` immediately
   surfaces E0004 in an open `main.si` — and restoring it clears the squiggle.
   Coverage: `src/caas/crossfile-diagnostics.test.ts`, `lsp/src/incremental.test.ts`.

2. **S1 binding identity.** A new lexical binder (`src/ast/binder.ts`) runs in
   `assembleSemanticModel` (both the full and incremental paths) and assigns
   every local name occurrence to its concrete binding — parameter, local
   definition, or `@match` pattern field — mirroring the typechecker's scope
   rules (one scope per body; locals bind from their definition onward;
   initializers see the outer binding).  The SemanticModel surfaces bindings
   as Symbols with **`containingSymbol` populated** (param type read off the
   containing fn's signature); `findReferences`/`rename` consume them: a
   parameter's references are exactly its own occurrences (never another
   function's same-named param), and a top-level rename **skips occurrences a
   shadowing local claimed**.  Parameters now carry their name-token span
   (parser change), so go-to-definition/hover work on params too.
   Coverage: `src/caas/binding-identity.test.ts` (12 tests).

3. **FFI 100%\*.** `Bun.$` — the single remaining skip — is now *officially*
   excluded from the gate (a tagged template is a JS syntactic form, not a
   callable member; a normal binding would break its escaping guarantee).  The
   exclusion list is CI-pinned to exactly `['Bun.$']` in
   `bindgen/adapters.test.ts`; the optional honest path remains
   [`bun-shell-ffi-plan.md`](bun-shell-ffi-plan.md).
