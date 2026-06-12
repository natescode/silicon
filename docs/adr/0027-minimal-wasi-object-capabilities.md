# ADR 0027 — Minimal WASI-aligned object-capability model (v0)

- **Status:** Accepted — implemented on current branch
- **Date:** 2026-06-11
- **Deciders:** NatesCode
- **Related:** ADR 0015 (object capabilities — the full vision this is a subset of) · ADR 0013 (capability-checker bootstrap, P0–P5) · ADR 0011 (borrow checker & rcaps) · ADR 0025 (WASI version target & world roadmap) · ADR 0023 (language identity & non-goals) · `compiler/src/stdlib/cap.si` · `compiler/src/strata/cap.si`

## Context

Silicon's privileged operations are **ambient** today: `fs::read_file` reads any
path, `global::fetch` reaches any URL, `bun::spawn` runs anything — no grant, no
gate (the only existing gate is the coarse compile-time `--platform` externref
check). Silicon lowers to WASM/WASI, and **WASI *is* an object-capability
model**: a module receives its authority — preopened descriptors — from the host
at the entry boundary; there is no ambient filesystem. The language story should
align with the execution model it already compiles to.

The full ocap vision is specified (ADR 0015: "capabilities are unforgeable
values, rooted at `main`, no ambient authority, attenuation is ordinary code")
but **entirely unbuilt** and heavy: the roadmap's K1–K8 needs a new `on::check`
strata phase, AST-reflection primitives, comptime collections, a call-graph
required-capability *fixpoint* checker, an effect lattice, and the borrow
checker. That is the destination, not a first step.

This ADR delivers the **smallest useful slice** — a real, runnable
object-capability foundation that *is* WASI's model (root authority at the
boundary, unforgeable handles, no ambient access, attenuation by passing) —
built entirely on **existing** mechanisms, with **zero new analysis pass**. It
is a strict, forward-compatible subset of ADR 0015; nothing here is discarded
when K1–K8 / WASI 0.2 land.

## The decisive finding

A `@type_distinct` registers **no value constructor**: `preRegisterTypeDecl`
(`compiler/src/types/typechecker.ts`) only records `DistinctOf(name, underlying)`
in `ctx.typeAliases` — unlike `@struct`, which mints a public constructor. No
cast keyword targets a distinct type, and `unify(Distinct, Int)` throws.
**Therefore a capability value is unforgeable *by representation*: ordinary code
has no way to mint a `World` or `Clock` — the only producer is a function whose
declared result is the cap type.** And the typechecker *already* rejects calling
a function that needs a `Clock` parameter when no `Clock` is in scope. **That
call-site type check is the entire enforcement engine** — v0 needs no capability
checker.

## Decision

### What a capability is
A capability is an opaque, host-rooted token: a `@type_distinct` over `Int`
(WASI-fd-shaped). `World` (root) and `Clock` (domain) are nominally distinct
types that lower to `i32`.

- **Unforgeable** — by representation (above).
- **Rooted** — the sole un-derived producer is the compiler's entry shim.
- **Flows** by ordinary parameter passing (already enforced at every call site).
- **Attenuated** — `world_clock(w World) -> Clock` derives a narrower cap from
  the root, using the one relabel primitive below.

### Rooting — `@fn main (World)` (Option A)
When a program defines `@fn main` whose first parameter is `World`, the
synthesised `_start`/`__start` shim calls `main(<root>)` with an inline root
token (`i32.const 3`, the first WASI non-stdio fd). **No user-nameable symbol
mints the root** — a callable `cap::root()` import was rejected because a
callable mint *is* ambient authority. On wasmtime/WASI no host shim is required;
the token is the language-level root, and the *real* grant is host-side
(wasmtime preopens), exactly as WASI fd numbers are integers the host binds.
Programs without a `World`-typed `main` are byte-for-byte unchanged.

### Attenuation — `@cap_derive`, confined to "downgrade from root"
Because distinct names don't unify, the cap stdlib needs a
representation-preserving relabel. `@cap_derive(x)`:
- **Runtime:** identity — emits zero instructions (the `@toU32`/`@toU64` relabel
  shape in `cast.si`).
- **Type:** a fresh type variable that unifies with the caller's declared
  domain-cap result (`-> Clock`).
- **Mint-site rule (E0017):** the argument **must be the root `World`**. So a
  cap can't be forged from a literal (`@cap_derive(0)` → rejected), nor can one
  domain cap be amplified into another (`@cap_derive(clock)` → rejected). Only
  the root downgrades. This is ADR 0013 P5 leg-1 ("mint-site restriction as a
  checker rule") realised at the keyword level — **not** the K4/K5 call-graph
  machinery, and **not** a new `on::check` phase.

### WASI mapping
| Cap | WASI surface | Host grant on `sgl run` | Stdlib it gates | v0 repr |
|---|---|---|---|---|
| `World` (root) | `wasi:cli/run` = `main` | injected inline by the entry shim; no import | `world_clock` (later `world_fs`, `world_env`) | i32 sentinel (3) |
| `Clock` | `wasi:clocks` / `clock_time_get` | always present | `clock_now(c)`, `monotonic_now(c)` | i32 (witness) |
| `Fs` *(follow-on)* | `wasi:filesystem` / `path_open` on a preopen | `sgl run --dir=.` → wasmtime `--dir` → preopened fd | `fs_open(fs,…)` then `fd_read`/`fd_write` | i32 dir-fd |

The **surface** (`main(World)`, cap params, attenuators) is permanent;
`Fs`/`Net`/`Env`/`Random`/`Exec` are mechanical copies of the same three moves.

### Representation — i32 default, externref opt-in
The v0 token is **i32** — it works on every target (native/WASI, wasm32,
wasm-gc, web/bun) and matches WASI Preview-1 fds exactly. An opt-in
`sgl.toml [build] cap-repr = "externref"` is **reserved for a future wasm-gc
mode** (truly opaque across the host boundary, riding the F1 externref work),
where it becomes the WASI-0.2 resource handle. v0 ships i32 only; `externref`
errors cleanly at the CLI.

## The honest residual seam (v0 non-goal)

Distinct types are nominal *by name, not by module*, and `@extern mod::field`
imports from an arbitrary module — so a determined user *can* re-declare a raw
privileged extern (`wasi_snapshot_preview1::path_open`) or use `@cap_derive` on a
`World` they were handed, bypassing the intended attenuation. v0 does **not**
claim to stop deliberate in-module circumvention (identical to ADR 0025's "an
integer fd is forgeable in-module"); it makes capability-passing the *normal,
ergonomic, statically-enforced* path and roots all blessed authority at `main`.
The real enforcement for privileged sinks remains host-side (wasmtime preopens):
a forged token grants nothing the host didn't preopen. The seam closes later
with P5 per-symbol module visibility + WASI-0.2 resource handles.

Native (QBE) cap rooting is also a follow-on: v0 targets the WASM/WASI path
(`sgl run` default), where the entry shim and WASI mapping apply.

## Growth — no rework

- i32 token → **WASI-0.2 resource handle** (or the externref opt-in) when
  `--emit=component` lands (ADR 0024/0025): the surface and mint sites are
  unchanged — that is the moment "forgeable in-module" becomes "unforgeable
  across the boundary."
- the keyword-level mint rule → **P5's `@capability` stratum + per-symbol
  visibility** (a structural seal — "unnameable" rather than "checked").
- required-cap *summaries* → **K1 `on::check` + K4 fixpoint + the ADR 0012
  effect certificate** ride on top later; v0's "a cap is a mandatory param" is
  already the bottom of that lattice (`pure ≙ no effect ocap`).

## Consequences

**Positive.** A real ocap foundation today, on existing machinery, zero new
analysis pass; authority is explicit, threaded, and statically checked;
unforgeable-by-representation for ordinary code; WASI-faithful; forward-
compatible with the full ADR 0015 / K1–K8 vision.

**Negative / accepted.** The in-module seam above (closed later). One new
keyword (`@cap_derive`) and one well-known type name (`World`) the compiler
hardcodes (as it hardcodes `main`). Attenuation is explicit parameter threading
(ergonomic ceiling — no inferred/ambient cap), which is the point.

## What shipped (this slice)

- `compiler/src/stdlib/cap.si` — `@type_distinct World/Clock`; `world_clock`
  attenuator; `clock_now`/`monotonic_now` over WASI `clock_time_get`.
- `compiler/src/strata/cap.si` — the `@cap_derive` relabel keyword (identity
  lowering).
- `compiler/src/types/typechecker.ts` — `@cap_derive` result typing + the
  E0017 mint-site rule (`CAP_ROOT_TYPE = 'World'`); `compiler/src/types/errors.ts`
  + `compiler/src/errors/diagnostic.ts` — the `CapDeriveNonRoot` (E0017)
  diagnostic.
- `compiler/src/ir/lower.ts` — the `main(World)` → `call $main (i32.const 3)`
  entry shim.
- `compiler/src/strata/modules/wasi_snapshot_preview1.si` — fixed
  `clock_time_get` precision to `Int64` (WASI ABI).
- `cli/src/sigil_cli.ts` — `[build] cap-repr` setting (i32 only; externref
  reserved).
- Tests: `compiler/src/e2e/capabilities.test.ts` (enforcement, unforgeability,
  mint-site rule, rooting, no-regression). Live `sgl run` prints a real WASI
  timestamp gated by a `Clock` capability.
