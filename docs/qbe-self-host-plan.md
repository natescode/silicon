# Self-hosting Silicon to native via QBE

**Status:** proposal · **Date:** 2026-06-01 · **Supersedes:** the Deno interim in
[`replacing-bun.md`](replacing-bun.md) as the long-term answer to the embedded-Bun
problem.

## What this is

Replace **Bun** — the runtime the compiler *itself* runs on — by compiling the
compiler to a native binary. Today `sgl` is TypeScript-on-Bun, sealed with
`bun build --compile`, which embeds an ~88 MB Bun runtime (statically-linked
JavaScriptCore/WebKit, **LGPL-2**). After self-hosting, `sgl` is a native ELF/
Mach-O: machine code, no embedded interpreter, single-digit MB, MIT-only.

**QBE is not being replaced.** The architecture stays
`Silicon → QBE IR (text) → qbe → assembly → cc/ld → native`. The compiler emits
QBE IR text and shells out to the `qbe` and `cc` binaries (external processes, not
embedded; `qbe` is MIT). We are *not* writing a register allocator or assembler —
QBE does that. "Extend the QBE backend" means extend the compiler's **QBE-IR
emitter** (`compiler/src/codegen/qbe/lower.ts`).

### Locked decisions (2026-06-01)

| Decision | Choice |
|---|---|
| Bootstrap approach | **Incremental port**, TS compiler kept as a differential-testing **oracle** during the port |
| Sequencing | **Extend the QBE-IR emitter to WASM-parity first**, then port the compiler to Silicon |
| Memory model | **Arena / bump allocator** (arena-per-pass; `@with_arena` lowered on native) |
| TS compiler fate | **Retire at the stage2 == stage1 fixpoint** |

### Goals / non-goals

- **Goal:** a small native `sgl`, built by `sgl` itself, with no embedded runtime
  and no LGPL obligation.
- **Non-goal:** replacing QBE; writing native codegen below QBE IR; changing the
  Silicon language.
- **In scope but off the native critical path:** porting the **WASM emitter** too,
  so the self-hosted compiler emits both targets. This keeps the wasm target
  first-party *and* powers the playground after the TS compiler is retired (the
  in-browser compiler becomes the Silicon compiler compiled to WASM by itself —
  see Phase 2.6 and Phase 4). It is sequenced alongside the QBE-emitter port, not
  ahead of the native fixpoint.

## Current state (audit, 2026-06-01)

| Component | LOC (excl. tests) | State |
|---|---:|---|
| TS compiler total | ~18,500 | production |
| — WASM codegen | 3,547 | mature: structs, sum types/`@match`, Vec, HashMap, GC — **ported in Phase 2.6**, becomes the oracle's strongest byte-for-byte check |
| — **QBE-IR emitter** | **1,345** | **scalars, control flow, functions, scalar `@extern` only** |
| — typecheck + unify | 2,629 | HM-lite, mature |
| — elaborator | 1,957 | strata dispatch, rich bodies |
| — comptime (engine + imports) | ~2,000 | hybrid: WASM fast path **+ AST-walking interpreter fallback** |
| — parser + ast | 1,625 | hand-written LL(1) |

**QBE-IR emitter gaps** (each currently throws/TODOs in `lower.ts`): `@struct`
layout & field access; sum types + `@match`; `Option`/`Result`; `Vec`/`HashMap`;
`@with_arena` (rejected at `lower.ts:632`); string operations (only literals
today); file I/O; full generic monomorphization (best-effort `w` fallback).

The language is *already* expressive enough to write a compiler — all of the above
work on the WASM backend. The gap is the native emitter, not Silicon.

## The comptime unlock

A compiler written in Silicon must, to compile *other* programs, run the strata
system (operators, `@if`, `@loop`, `@match`, `@struct`, …) whose bodies call the
`&Compiler::*` API. Today that has two execution paths:

1. **WASM compile-then-run** (`engine.ts`) — compiles a handler body to WASM and
   instantiates it. A *performance optimization* (the "T0 fast path").
2. **AST-walking interpreter** (`compileHandlerBlock` + the `&Compiler::*`
   interpreter surface) — the functional fallback.

**The native compiler implements path 2 only.** It walks the handler AST in native
Silicon — no WASM engine inside the binary. Path 1 is a TS-only optimization that
is *not* ported. (Later, [`comptime-via-compilation.md`](comptime-via-compilation.md)
can re-introduce speed by compiling handlers straight to native and calling them —
but that is a post-1.0 optimization, explicitly out of this plan's critical path.)

This removes the one architectural blocker that would otherwise force a runtime
engine back into the binary.

## Plan

Two tracks. **Track A** (extend the QBE emitter) runs on the *current TS compiler*
and must reach parity before **Track B** (port the compiler to Silicon) can
compile itself to native. The **oracle** gates both: every program in a growing
corpus is compiled by the TS→WASM reference and by the path under test, and their
observable behavior (exit code + stdout) — and, where applicable, their IR text —
must match exactly.

### Phase 0 — Harness + native runtime surface

1. **Differential oracle.** Extend `compiler/src/e2e/backends.test.ts`'s
   `BOTH_BACKENDS` corpus into the gating harness: for each `.si` program, compile
   via TS→WASM (run under wasmtime) and via TS→QBE→`qbe`→`cc` (run native), and
   assert identical exit code + stdout. Add IR-determinism checks (byte-identical
   QBE IR across two compiles — already present for the scalar subset). CI fails on
   any divergence. The corpus grows as each Phase-1 feature lands.
2. **Native runtime/std (`@extern` libc/POSIX).** Author a native std module (the
   current `io.si` is WASI-only and unusable on native):
   - memory: `malloc`, `free`, `memcpy`, `memset`;
   - output/input: `write`/`read` on fds, `open`/`close` (POSIX) for reading source
     files and writing artifacts;
   - process: `argc`/`argv` access and exit code (the compiler needs CLI args and
     file paths);
   - strings: `strlen`, compare, plus Silicon-side concat / substring / int↔string.
   This std is needed both by compiled user programs *and* by the self-hosted
   compiler.
3. **String representation decision.** Keep Silicon's UTF-8 + 4-byte length header
   (matches WASM, needed for slicing) and ensure a trailing NUL when a string
   crosses an `@extern` boundary, so libc calls (`puts`, `open`) still work. Record
   this in `docs/targets.md`.

### Phase 1 — QBE-IR emitter to WASM-parity (Track A, the long pole)

Each sub-phase: implement lowering in `lower.ts` + `types.ts`, add native e2e +
cross-backend determinism tests, expand the oracle corpus. Reuse the WASM backend's
layout decisions verbatim so the two backends agree (the oracle enforces this).

| # | Feature | Notes |
|---|---|---|
| 1.1 | **Strings** | data-section layout with length header; concat, length, substring; NUL-bridge for `@extern` |
| 1.2 | **Arenas / allocator** | lower `@with_arena` / `@move_to_parent_arena`: `malloc` a block, bump a pointer, free at scope exit. Replaces the `lower.ts:632` rejection |
| 1.3 | **Structs** | `@struct` field layout (same record layout as WASM), construction, field read/write, by-value vs pointer passing |
| 1.4 | **Sum types + `@match`** | `[tag, field0…]` pad-to-max layout, variant constructors, match dispatch + destructure, pattern alternation. `Option`/`Result` fall out |
| 1.5 | **Vec / HashMap / slice** | once arenas + structs + generics work, the stdlib `.si` compiles to native unchanged |
| 1.6 | **Generic monomorphization** | reuse the typechecker's instantiation so `@fn[T]` / `@type[T]` emit concrete QBE, replacing the best-effort `w` fallback |
| 1.7 | **File I/O** | POSIX `@extern` wrappers; the compiler reads `.si` files and writes `.qbe`/binaries |
| 1.8 | **funcref (if needed)** | only if the compiler uses indirect dispatch the interpreter can't avoid |

**Milestone M1:** every corpus program that compiles on WASM compiles and runs
*identically* on native. The QBE emitter is at parity. Track B can begin compiling
real compiler code to native.

### Phase 2 — Port the compiler to Silicon (Track B, incremental + oracle-gated)

Port leaves-first; after each subsystem, run the TS and Silicon implementations on
the corpus and diff their intermediate output (token stream → AST JSON → QBE IR
text) until byte-identical, then switch authority to the Silicon version.

1. **Lexer** → **Parser/AST** (`parser/handwritten/*`, `ast/*`): compare token
   streams and AST JSON against the TS oracle.
2. **AST data model**: the node types become Silicon sum types — the first heavy
   user of Phase 1.4.
3. **Strata loader + registry** (`elaborator/strataLoader.ts`, `registry.ts`).
4. **Elaborator + comptime** (`elaborator/elaborator.ts`, `comptime/imports.ts`):
   port the **AST-walking interpreter** and the `&Compiler::*` surface. Largest and
   riskiest subsystem; the comptime unlock above makes it tractable.
5. **Typechecker + unify** (`types/*`): HM-lite; diff inferred types against the
   oracle.
6. **Backends — port both emitters.** The self-hosted compiler must emit both
   targets.
   - **WASM emitter first** (`codegen/*`, 3,547 LOC): port it before the QBE emitter
     because it gives the oracle its strongest check — `Silicon→WASM` IR can be
     diffed **byte-for-byte** against the mature `TS→WASM` reference (the wasm
     emitter is fully deterministic and the playground already depends on it). When
     that diff is clean, the entire front end + WASM backend is proven equivalent.
   - **QBE-IR emitter** (`codegen/qbe/*`, post-Phase-1): the Silicon compiler emits
     QBE IR text; diff against the TS QBE emitter byte-for-byte. This is the
     backend the compiler uses to compile *itself* to native.
   - **Platform abstraction:** carry over the `.native` / `.browser` asset+I/O split
     (today done with Bun source-swap plugins) into Silicon so the compiler builds
     for two hosts — native (real fs/POSIX) and browser (inlined assets, no fs).
     This is what lets the same Silicon source compile both the native `sgl` and the
     in-browser playground compiler.
7. **CLI + native driver** (`cli/src/sigil_cli.ts`, `cli/src/native/*`): manifest
   parsing, and shelling out to `qbe` + `cc`.

### Phase 3 — Bootstrap + fixpoint

1. **stage0** (TS compiler, on Bun) compiles the Silicon compiler source → **stage1**
   (native binary, via QBE).
2. **stage1** compiles the same Silicon source → **stage2** (native binary).
3. Assert **stage1 == stage2** byte-for-byte. Equality proves self-hosting: the
   compiler is a fixed point. (The existing determinism tests already enforce
   byte-stable output, so deterministic iteration order is in hand.)
4. **WASM self-host check:** `stage1` compiles the Silicon compiler source to the
   **WASM** target → `silicon-compiler.wasm`, and that module compiles the corpus
   identically to `stage1`-native. This is the artifact the playground loads
   post-retirement (the compiler running itself in the browser).

After this, `stage1` builds itself (native and wasm); Bun/TS are only needed to
*re-bootstrap from scratch*.

**Milestone M3:** the full test corpus is green when compiled by `stage1` (native),
the `stage1 == stage2` fixpoint holds across a clean rebuild, and
`silicon-compiler.wasm` produced by `stage1` passes the corpus in-browser.

### Phase 4 — Retire the TS compiler

Once the fixpoint is stable and the corpus is green under `stage1` (both backends
ported in Phase 2.6, so there is no remaining wasm-target dependency on the TS
compiler):

1. **Swap the playground compiler.** Replace the in-browser TS-compiler bundle with
   `silicon-compiler.wasm` (the Silicon compiler compiled to WASM by `stage1`,
   Phase 3.4). The playground now runs the real compiler in the browser with no TS
   in the loop. Re-run the headless smoke test against it.
2. Delete `compiler/src` TS, the `bun build --compile` path, and the Bun
   browser-bundle build; ship `sgl` built by `sgl`.
3. **Archive** the final TS compiler at a tagged commit so a clean re-bootstrap is
   always possible from source.
4. **Licensing:** drop the Bun/LGPL section from `cli/THIRD-PARTY-LICENSES.md` and
   `compiler/NOTICE.md`; the binary is MIT-only. `qbe` + `cc` are external build
   tools (MIT / system toolchain), not redistributed in the binary.

## Memory model — arenas

The compiler allocates heavily (AST nodes, symbol tables, interned strings) and is
short-lived, which is the textbook case for arenas:

- **Native arena** = `@extern malloc` one block (grow by chaining blocks), bump an
  offset on allocation, free the chain at scope exit. The QBE emitter lowers
  `@with_arena` to exactly this (Phase 1.2).
- **Arena-per-pass:** a parse arena lives across the whole compile; transient
  passes get scoped arenas freed at pass end. Leak-on-process-exit is acceptable.

This dogfoods Silicon's flagship memory story ([`memory.md`](memory.md)) and needs
no GC inside the compiler.

## Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| Comptime would need a WASM engine in the binary | **was critical** | **resolved** — native compiler uses the AST-walking interpreter; WASM fast path not ported |
| QBE-emitter parity is a large build-out (~1.3k → ~3–4k LOC) | high | incremental, oracle-gated per feature; reuse WASM layout decisions so the two agree |
| Two implementations drift during the port | high | the oracle diffs token/AST/IR output on every CI run; authority only switches after byte-identical |
| Generic monomorphization immature on native | medium | reuse the typechecker's existing instantiation logic |
| Bootstrap non-determinism breaks the fixpoint | medium | determinism tests already enforce byte-stable IR; pin iteration order, no hash-order maps in codegen |
| Float / ABI mismatches via QBE→cc | medium | runtime diff tests (exit code + stdout) catch behavioral divergence |
| macOS cross-build / codesigning | low | build per-OS in CI |
| `&Compiler::*` surface is large to port | medium | port incrementally behind the oracle; trim dead API while porting |
| WASM-emitter port (3,547 LOC) doubles backend work | medium | it's a port, not new design; the byte-for-byte `Silicon→WASM == TS→WASM` diff makes it self-verifying, and it powers the playground swap |
| Browser host: compiler-as-wasm needs no-fs platform shim | medium | port the existing `.native`/`.browser` asset+I/O split into Silicon; headless smoke test gates the playground swap (Phase 4.1) |

## Definition of done

- `sgl` is a native binary, single-digit MB, **built by `sgl` itself** (`stage1`).
- No Bun, no embedded runtime; only `qbe` + `cc` invoked as external build tools.
- `stage1 == stage2` fixpoint holds on a clean rebuild; full corpus green under
  `stage1`.
- **Both backends are first-party in Silicon:** `stage1` emits native (via QBE) and
  WASM; the playground runs `silicon-compiler.wasm` (the compiler compiled to wasm
  by itself), with the headless smoke test green and no TS in the loop.
- `THIRD-PARTY-LICENSES.md` carries no LGPL/WebKit obligation; the binary is
  MIT-only.

## Relationship to other docs

- [`replacing-bun.md`](replacing-bun.md) — the cheap interim (swap `bun --compile`
  for `deno compile`): removes LGPL in ~2 files but keeps a ~80 MB V8 binary. Use
  it as a bridge if the licensing fix is needed *before* this multi-phase effort
  lands.
- [`comptime-via-compilation.md`](comptime-via-compilation.md) — the post-1.0
  comptime perf path (native-compiled handlers); not on this plan's critical path.
- [`memory.md`](memory.md) — the arena model this dogfoods.
- `docs/archive/` bootstrap plans — the previous (removed `boot/`) attempt; this
  plan replaces them.
