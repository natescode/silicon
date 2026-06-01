# Silicon

**Silicon** is a small, multi-paradigm programming language that compiles to
WebAssembly (WAT/WASM) and — via [QBE](https://c9x.me/compile/) — to native
binaries. Its compiler is named **Sigil** and is written in TypeScript, run
under [Bun](https://bun.sh).

Silicon's defining idea is **syntax ≠ semantics**: the grammar is tiny, stable,
and LL(1), and new operators and keywords are added as *data* (called
**Strata**) rather than by changing the grammar. `@if`, `@loop`, `+`, `==`, and
friends are all defined in Silicon source under the compiler's `strata/` tree,
not hard-coded into the parser.

```silicon
\\ add (Int, Int)
@fn add a, b := { a + b };

\\ main () -> Int
@fn main := &add 2, 3;
@export main;
```

> **Status:** the TypeScript compiler is the production compiler. A
> Silicon-in-Silicon bootstrap is planned for the future. See
> [`compiler/README.md`](compiler/README.md) and [`docs/`](docs/) for details.

---

## Repository layout

This repo is a [Bun workspaces](https://bun.sh/docs/install/workspaces)
monorepo. Everything is developed together and deployed separately. The
top-level directories fall into three groups: **the compiler**, **things that
depend on the compiler**, and **supporting material**.

| Directory | Package | What it is |
|---|---|---|
| [`compiler/`](compiler/) | `@silicon/compiler` | The Sigil compiler — parser, strata elaborator, HM-lite typechecker, and the WASM + QBE-native backends. The core everything else builds on. |
| [`cli/`](cli/) | `@silicon/cli` | The `sgl` command-line tool (`init` / `build` / `run` / `check`) and the native-toolchain drivers (QBE + linker). |
| [`lsp/`](lsp/) | `@silicon/lsp` | The Language Server — diagnostics, hover, go-to-definition — built on the compiler's Compiler-as-a-Service API. |
| [`playground/`](playground/) | `silicon-playground` | A Bun HTTP server + browser UI that compiles Silicon source to WAT/WASM live. |
| [`plugins/vscode/`](plugins/vscode/) | `silicon-vscode` | The VS Code extension: syntax highlighting, theme, and a thin client around the LSP. |
| [`website/`](website/) | `silicon-docs` | The public documentation site (VitePress); renders the contents of `docs/`. |
| [`docs/`](docs/) | — | Source-of-truth documentation: architecture, ADRs, the strata and CaaS references. Indexed by [`docs/README.md`](docs/README.md). |
| [`examples/`](examples/) | — | Sample Silicon programs (`*.si`) and their compiled output. |
| [`assets/`](assets/) | — | Logos and shared brand assets. |
| [`blog/`](blog/) | — | Release announcements and long-form write-ups. |

### How the pieces depend on each other

`@silicon/compiler` is the hub. The CLI, the LSP, and the playground are all
**thin layers over it** — they import it as a workspace dependency
(`"@silicon/compiler": "workspace:*"`) rather than vendoring or duplicating any
compiler code. There is exactly one implementation of the language, and the
tools share it.

```
                         ┌───────────────────────┐
                         │   @silicon/compiler    │   parser → strata elaborator
                         │   (the Sigil compiler) │   → typechecker → WASM / QBE
                         └───────────┬───────────┘
              ┌──────────────────────┼──────────────────────┐
              │                      │                      │
     ┌────────▼────────┐   ┌─────────▼────────┐   ┌──────────▼─────────┐
     │  @silicon/cli   │   │  @silicon/lsp    │   │ silicon-playground │
     │  (`sgl` tool)   │   │ (language server)│   │ (web compile API)  │
     └─────────────────┘   └────────┬─────────┘   └────────────────────┘
                                    │
                          ┌─────────▼─────────┐
                          │  silicon-vscode   │   imports the LSP; ships it
                          │ (editor extension)│   inside the extension
                          └───────────────────┘

     silicon-docs (website/)  ──renders──▶  docs/        (no code dependency)
```

- **CLI → compiler.** `sgl build`/`run`/`check` call the compiler's public API
  (and its `/native` entry for the QBE + linker path) to turn `.si` files into
  WASM or native binaries.
- **LSP → compiler.** The language server is intentionally thin: it wraps the
  compiler's Compiler-as-a-Service surface (`check`, semantic model,
  diagnostics-as-data) and translates it to LSP messages. See
  [`docs/compiler-as-a-service.md`](docs/compiler-as-a-service.md).
- **VS Code extension → LSP.** `plugins/vscode` depends on `@silicon/lsp`
  (not on the compiler directly) and bundles it as the extension's server.
- **Playground → compiler.** The server imports `@silicon/compiler/pipeline`
  — a subpath exposing the raw pipeline stages — and returns WAT, WASM, and
  per-export type info to the browser UI.
- **Website → docs.** The docs site is content-only: it builds the Markdown in
  `docs/` into a static site and has no dependency on compiler code.

---

## Getting started

Requires **Bun ≥ 1.0**. Native execution of compiled WASI binaries uses
**wasmtime**; `.wat → .wasm` assembly uses **wat2wasm** (from WABT) or the
bundled `binaryen`.

```sh
bun install                                  # install + link all workspace packages

bun --filter '@silicon/compiler' test        # run the compiler test suite
bun --filter '@silicon/cli' sgl --help       # the sgl CLI (init / build / run / check)
bun --filter 'silicon-playground' start      # playground → http://localhost:3001
```

For real project work, build a standalone `sgl` binary and put it on your
`PATH` — then `init`/`build`/`run`/`check` operate on the current project:

```sh
bun --filter '@silicon/cli' build:sigilc      # → cli/dist/sigilc
./cli/dist/sigilc init my-project
cd my-project
sgl run                                        # compile + execute via wasmtime
```

(`init [name]` scaffolds `name/`; `build`/`run`/`check` take an optional
`[file]`, defaulting to the project's entry.)

Each package has its own scripts; see its `package.json`. The compiler's
`CLAUDE.md` and [`docs/README.md`](docs/README.md) are the best entry points
into the architecture.
