# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**Silicon** is a systems programming language targeting WebAssembly (WAT/WASM, including wasm-gc) and — via QBE — native binaries. Its compiler, **Sigil**, is written in TypeScript and runs under **Bun**. This is a Bun-workspaces monorepo; `@silicon/compiler` is the hub and everything else (CLI, LSP, playground, VS Code plugin) is a thin layer importing it as `workspace:*`.

**See `compiler/CLAUDE.md` for compiler-internals guidance** (pipeline phases, strata system, type inference, sum types, `@match` form, integer hierarchy). This file covers the monorepo level.

## Goals & Philosophy

Silicon is a **minimal, wasm-first, multi-paradigm, gradually memory-managed, self-extending language**. These principles drive design decisions:

- **Eternal grammar.** The grammar is designed to never change. After v1.0 it will not change again, ever. All grammar changes must go through the language author (natescode). Semantics ≠ grammar: **Strata** are the mechanism for extending the language's *semantics* without touching its *grammar*.
- **Strata are the big idea.** Internal compiler phases are exposed to the language as intrinsics, allowing Silicon to start from a Turing-incomplete minimal core language (**SiliconCore / SiCore**) and build everything else on top. Consequently, **Sigil** is more a language *toolkit* than Silicon's compiler — Silicon's compiler is really a collection of Strata (written in Silicon `.si` files) that extend the base Sigil compiler.
- **Explicit and consistent, but not *too* explicit.** Silicon avoids complexity and prefers explicitness — yet it loves type inference. Keeping types out of the syntax means the same syntax can carry different semantics (e.g. a future borrow checker) without grammar changes.
- **WASM is the main target — and a deliberately leaky abstraction.** Silicon aims to be a high-level abstraction *over* WASM, not hiding it. The QBE backend (and later Cranelift) exists *only* for bootstrapping: the goal is a self-hosted Silicon compiler that is a native binary, not a compiler running in wasm.
- **Both interpreted and compiled.** Silicon must be interpretable to support comptime in Strata. Long-term: a bootstrapped compiler *and* a bootstrapped interpreter.

## Repository Layout

| Directory | What it is |
|---|---|
| `compiler/` | `@silicon/compiler` — parser, strata elaborator, HM-lite typechecker, WASM + QBE backends, stdlib (`src/stdlib/*.si`), CaaS API (`src/caas/`) |
| `cli/` | `@silicon/cli` — the `sgl` tool (`init`/`build`/`run`/`check`) at `cli/src/sigil_cli.ts`, plus native-toolchain drivers (QBE + linker) |
| `lsp/` | `@silicon/lsp` — language server built on the compiler's CaaS surface |
| `playground/` | Browser app compiling Silicon client-side; built by embedding the compiler |
| `plugins/vscode/` | VS Code extension; depends on `@silicon/lsp`, not the compiler directly |
| `website/` | VitePress docs site; renders `docs/` (content-only, no code dependency) |
| `docs/` | Source-of-truth docs: `grammar.ebnf`, `strata.md`, `compiler-api.md`, `compiler-as-a-service.md`, `hm-lite.md`, `v1-feature-status.md`, and `docs/adr/` (design decisions — check here before architectural changes) |

## Commands

```sh
bun install                                    # link all workspace packages

# Tests (Bun's built-in runner; tests live alongside code as *.test.ts)
bun --filter '@silicon/compiler' test          # compiler suite
cd compiler && bun test src/types              # run a directory
cd compiler && bun test src/types/typechecker.test.ts   # run a single file
cd compiler && bun run test:qbe                # QBE/native backend tests
cd compiler && bun run test:backends           # wasm-gc + native e2e
bun --filter '@silicon/cli' test               # CLI tests
bun --filter '@silicon/lsp' test               # LSP tests

# Running the CLI / compiler
bun run cli/src/sigil_cli.ts <build|run|check> [file]   # invoke sgl from source
bun --filter 'silicon-playground' start        # playground → http://localhost:3001
```

**Gotcha:** a globally installed `sgl` binary (`~/.sgl/bin/sgl`) may shadow the workspace. To test compiler edits, always run `bun run cli/src/sigil_cli.ts` from the repo, never the global `sgl`.

Tooling: **Bun ≥ 1.0**; **wasmtime** to execute compiled WASI binaries; **wat2wasm** (WABT) or the bundled `binaryen` for `.wat → .wasm`.

## Big-Picture Architecture

Pipeline (wired in `compiler/src/index.ts`; raw stages exported via `@silicon/compiler/pipeline`):

```
Source → Parser → AST → Strata loader → Elaborator → Typecheck → IR → WASM emitter (wat)
                                                                   └→ QBE lowering → native
```

- **Syntax ≠ semantics (Strata).** The grammar is tiny, stable, hand-written LL(1) (`compiler/src/parser/handwritten/`). Every operator and keyword (`@if`, `@loop`, `+`, `==`, …) is defined as *data* in Silicon source under `compiler/src/strata/*.si`, loaded by `strataLoader.ts` and executed by the elaborator's body interpreter against the `Compiler::*` API (`compiler/src/compiler-api/`). **New language features default to adding a stratum, never changing the grammar** — grammar changes need discussion first.
- **Two backends, one IR.** `compiler/src/ir/lower.ts` lowers the typed AST; `codegen/` emits WAT (wasm-gc per ADR-0009), `codegen/qbe/lower.ts` emits QBE IR for native. The CLI shells out to `qbe` + system `cc` for linking. Every IR expression carries `inferredType`/`wasmType` — lowering picks instructions from types, never from string-sniffing WAT.
- **Module system (ADR-0024).** Three tiers: component (root with `sgl.toml`) → module (directory) → file. Implemented as a source-merge front-end: `compiler/src/modules/component.ts` rewrites cross-module `M::f` to flat `M__f` identifiers before `compile()`. Visibility is private-by-default; `@pub` exports.
- **CaaS (`compiler/src/caas/`)** is the stable Roslyn-style library surface (incremental compile, semantic model, workspace) that the LSP and playground consume.
- **Stdlib** is Silicon source in `compiler/src/stdlib/*.si`, resolved via `@use 'name'`; `std.wat` runtime helpers are embedded into the compiler at build time.

## Language Gotchas (when writing `.si` code or tests)

- **Flat operator precedence** (ADR-0020): all binary operators are equal precedence, left-to-right. `2 + 3 * 4` is `20`, not 14. Parenthesize aggressively.
- **Line-independent parsing**: no multi-line binary expressions; each line parses standalone.
- Type annotations for locals go on a `\\ name Type` signature line *above* the definition, not inline.
- No integer-literal suffixes; use `@i64(x)` / `@u64(x)` casts. No implicit width coercion.
- `@match` arms are flat call arguments: `@match(x, $Some v, { v }, $None, { 0 })` — the infix `=> ` arm form was removed.
