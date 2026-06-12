# Bootstrap: blockers and order of work

**Status:** assessment · **Date:** 2026-06-12 · **Companion to:**
[`qbe-self-host-plan.md`](qbe-self-host-plan.md) (the locked plan this
summarizes and sequences against), [`v1-feature-status.md`](v1-feature-status.md).

## What this is

With the v1.0 gate closed, this doc answers: *what actually blocks
self-hosting, and in what order does the work land* — through bootstrap, a
Silicon-native comptime, the Silicon-written interpreter, and finally
user-facing comptime Strata. It is a snapshot assessment verified against the
code on `v1-roadmap` (post-`6ea1aaa`); the authoritative phase detail stays in
the self-host plan.

## Headline

**Nothing blocks at the language level.** The full v1 surface — sum types +
`@match`, `@fn[T]`/`@type[T]` generics with monomorphization (M0/M1),
`Vec[T]`/`HashMap[K,V]`, strings + `StrBuilder`, `Result`/`@try`, modules
(ADR-0024), `Rc[T]` for recursive AST nodes — works on the WASM backend today.
That is enough expressiveness to write a compiler in Silicon. Every blocker is
infrastructure, and they sequence cleanly.

## The three real blockers

### 1. The QBE emitter is the long pole

`compiler/src/codegen/qbe/lower.ts` is ~1,345 LOC covering scalars, control
flow, functions, and scalar `@extern` only. It throws or TODOs on:

- strings (literals only — no concat/slice/compare),
- `@with_arena` (rejected at `lower.ts:632`),
- structs (`@type` records: layout, field access),
- sum types + `@match` (so `Option`/`Result` too),
- `Vec`/`HashMap` (blocked on arenas + structs + generics),
- full generic monomorphization (best-effort `w` fallback),
- file I/O.

The WASM emitter (3,547 LOC) is the layout reference; QBE must roughly triple
to reach parity. A Silicon-written compiler cannot compile *itself to native*
until this exists. This is Phase 1 of the plan ("the long pole").

### 2. No native runtime/std

`stdlib/io.si` is WASI-only. A native compiler needs a libc/POSIX `@extern`
std module: `malloc`/`free`/`memcpy`/`memset`; `open`/`read`/`write`/`close`;
`argc`/`argv` + exit codes; string bridging (Silicon's length-prefixed UTF-8
gets a trailing NUL at the `@extern` boundary so `puts`/`open` work). Needed by
both compiled user programs and the self-hosted compiler. This is Phase 0.2–0.3.

### 3. Comptime must not require a WASM engine in the binary

> **Corrected 2026-06-12** (by [`bootstrap-foundation-audit.md`](bootstrap-foundation-audit.md)
> R1): this section originally repeated the self-host plan's premise that the
> AST-walking interpreter survives as the functional fallback to port. **It
> does not.** The D-E-3 dissolution retired it: named handlers throw without
> a compiled instance, inline blocks are auto-extracted and compiled — every
> strata handler executes exclusively as compiled WASM today. The native
> comptime strategy must be *re-decided*, not ported; the audit's R1 lays out
> the options (static-link T0 handlers into the compiler binary; write a
> fresh interpreter in Silicon for user strata; native compile-and-dlopen).
> The plan's constraint stands — no WASM engine in the native binary — but
> the "port the interpreter" path to satisfying it is gone.

## Order of work

One sequencing note up front: **the Silicon-written interpreter is *part of*
the bootstrap, not after it.** The self-hosted compiler needs it to run strata
at all, so it lands mid-port (Phase 2.4), and "Silicon-native comptime" falls
out of that step — closing the `v1-feature-status.md` line "comptime runs on
the host today (ADR-0003 pivot)".

| Step | What | Gate / milestone |
|---|---|---|
| **Phase 0** | Differential oracle (TS→WASM vs TS→QBE: exit code + stdout + byte-stable IR) + native std (`@extern` libc) + string-repr decision | corpus harness in CI |
| **Phase 1** | QBE emitter to WASM-parity: 1.1 strings → 1.2 arenas → 1.3 structs → 1.4 sums/`@match` → 1.5 Vec/HashMap/slice (stdlib `.si` compiles unchanged) → 1.6 generic mono → 1.7 file I/O → 1.8 funcref if needed | **M1:** every corpus program runs identically on both backends |
| **Phase 2** | Port the compiler to Silicon, leaves-first, authority switches only on byte-identical diffs: lexer → parser (token/AST-JSON diff) → AST as Silicon sum types (first heavy 1.4 user; `Rc[T]` boxing) → strata loader/registry → **elaborator + AST-walking interpreter + `Compiler::*` surface** (largest, riskiest; the comptime unlock) → typechecker (diff inferred types) → backends, **WASM emitter first** (byte-diffs against the mature TS reference, proving the whole front end), then QBE → CLI + native driver | per-subsystem byte-identical vs oracle |
| **Phase 3** | stage0 (TS) → stage1 (native) → stage2; assert `stage1 == stage2` byte-for-byte; stage1 also emits `silicon-compiler.wasm`, corpus-green in-browser | **M3:** fixpoint + wasm self-host check |
| **Phase 4** | Swap playground to `silicon-compiler.wasm`; delete TS compiler (archived at a tag for re-bootstrap); drop Bun/LGPL | `sgl` built by `sgl`, MIT-only |

## After the fixpoint: comptime Strata as the open mod surface

User-facing comptime strata (third-party packages registering types, operators,
IR passes, codegen) become possible only post-bootstrap, and need things the
bootstrap itself doesn't:

1. **Open-tagged IR** (bootstrap-plan R1) — strata can introduce new IR node
   kinds without compiler patches. Falls out naturally during the Phase 2 port
   if the registry stays registry-driven (it already is in TS for operators,
   control flow, def-kinds).
2. **New phase hooks.** Today's `StratumPhase` set
   (`decl`/`callSite`/`annotation`/`lower`/`moduleFinalize`/`comptime`,
   `elaborator/registry.ts`) is entirely front-end. `on::optimize` (first
   candidate: constant-folding nullary-const globals — see
   [`strata.md`](strata.md) §"Future: an optimization phase") and `on::check`
   do not exist yet.
3. **Reflection over the typed AST** — the ADR-0013 P1–P5 track
   (`ast_inferred_type` etc.); also gates the K1–K8 capability checker being
   written as a stratum.
4. **Comptime-via-compilation, natively** — the self-hosted compiler compiles
   handlers to native and calls them, replacing AST-walking as the fast path
   ([`comptime-via-compilation.md`](comptime-via-compilation.md)).

## Risk worth acting on now

**~~Interpreter-path rot~~ — overtaken by events.** This section recommended
a CI mode forcing the interpreter path; the foundation audit then found the
interpreter is already fully retired (no path to force). The successor
recommendation is the audit's D2: build a **handler-equivalence harness** for
whichever R1 comptime strategy is chosen, so the new execution path is diffed
against today's compiled-WASM behavior across the full strata suite.

## Relationship to other docs

- [`qbe-self-host-plan.md`](qbe-self-host-plan.md) — the locked plan; phase
  detail, risk register, definition of done. This doc is the
  blockers-and-ordering summary of it plus the post-fixpoint Strata track.
- [`comptime-via-compilation.md`](comptime-via-compilation.md) — the post-1.0
  comptime perf path.
- [`strata.md`](strata.md) — phase hooks today + the `on::optimize` proposal.
- ADR-0003 (comptime engine path), ADR-0013 (capability checker bootstrap,
  P1–P5 reflection track), ADR-0024 (modules).
