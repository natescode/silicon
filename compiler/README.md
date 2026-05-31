# Sigil — the Silicon compiler

Sigil compiles the **Silicon** programming language to WebAssembly (WAT/WASM)
and — via QBE — to native binaries. The compiler is implemented in
TypeScript and ships as the `sgl` CLI.

**Status:** The TypeScript compiler in `src/` is the working compiler. A
Silicon-in-Silicon bootstrap previously lived under `boot/`; it has been
removed and is planned to be rewritten from scratch. The historical
bootstrap-plan documents remain in `docs/` for reference but no longer
describe the working pipeline.

Architecture, the strata extension system, and the compiler API surface live in:

- [`CLAUDE.md`](CLAUDE.md) — pipeline overview, where to look first
- [`docs/strata.md`](docs/strata.md) — the open extension system
- [`docs/compiler-api.md`](docs/compiler-api.md) — the `&Compiler::*` surface
- [`docs/compiler-as-a-service.md`](docs/compiler-as-a-service.md) — the CaaS library API
- [`docs/hm-lite.md`](docs/hm-lite.md) — type inference reference

## Prerequisites

- [Bun](https://bun.sh/) ≥ 1.0 — runs the TypeScript compiler and tests
- [Wasmtime](https://docs.wasmtime.dev/cli-install.html) ≥ 14 — WASI runtime
  used by `sgl run` and the test suite
- [WABT](https://github.com/WebAssembly/wabt) — provides `wat2wasm`
  (auto-fetched to `./bin/` via `scripts/install-wat2wasm.{sh,ps1}` if
  you'd rather not install system-wide)

Quick install:

```sh
curl -fsSL https://bun.sh/install | bash             # Bun
curl https://wasmtime.dev/install.sh -sSf | bash     # Wasmtime (macOS / Linux)

# WABT (system-wide)
brew install wabt                                    # macOS
sudo apt install wabt                                # Debian / Ubuntu

# WABT (project-local — no admin needed)
./scripts/install-wat2wasm.sh                        # bash; fetches to ./bin/
.\scripts\install-wat2wasm.ps1                       # PowerShell
```

Why wasmtime: it's the WASI reference implementation. Wasmer's WASI compat
layer has known bugs at both 2.x (mapped-dir rights) and 7.x (post-`path_open`
fd corruption + Windows absolute-path stdout).

## Build and test

```sh
git clone https://github.com/natescode/sigil.git
cd sigil
bun install
bun test                              # run the full Bun test suite
bun run build:sigilc                  # compile the sgl CLI into dist/sigilc
```

## Compile a Silicon program

The easiest path is the `sgl` CLI:

```sh
bun run sgl init my-project
cd my-project
bun --cwd .. run sgl run              # compile + execute under wasmtime
```

Or drive the pipeline directly via the public CaaS API in `src/caas/`. See
[`docs/compiler-as-a-service.md`](docs/compiler-as-a-service.md) for the
stable surface (parse → buildRegistry → elaborate → typecheck → lower).

## Editing a built-in stratum

Built-in operators / keywords live in `src/strata/*.si`. After editing,
re-run the relevant tests (`bun test src/strata`) to make sure the new
behaviour matches the regression suite.

## Repository layout

```
src/                   TypeScript compiler — parser, elaborator, typechecker, codegen
src/strata/            Built-in Silicon strata — operators, control flow, definition kinds
src/stdlib/            Silicon-side standard library (Option, Result, Vec, HashMap, …)
src/caas/              Compiler-as-a-Service public API
src/codegen/qbe/       QBE backend (native targets)
scripts/               Install + build helpers
docs/                  Architecture, plans, strata, compiler-api, type-inference reference
bin/                   wat2wasm fetched by scripts/install-wat2wasm.{sh,ps1}
tests/                 Property + fuzz suites
```

## Contributing

Open an issue or PR. The Silicon grammar is intentionally frozen — new
language features ride the strata system rather than the parser. See
`CLAUDE.md` → "Adding a Language Feature" before proposing grammar
changes.

## License

MIT. See [LICENSE.md](LICENSE.md).
