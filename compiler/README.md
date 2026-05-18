# Sigil — the Silicon compiler

Sigil compiles the **Silicon** programming language to WebAssembly (WAT/WASM).

**Status:** Stage 0 (TypeScript on [Bun](https://bun.sh/)). Self-hosting in
Silicon is in flight — `stage1.wasm` already compiles its own source to a
byte-identical fixed point. See [`docs/bootstrap-plan.html`](docs/bootstrap-plan.html)
for the roadmap and [`docs/bootstrap-status.md`](docs/bootstrap-status.md) for
what's landed.

Architecture, the strata extension system, and the compiler API surface live in:

- [`CLAUDE.md`](CLAUDE.md) — pipeline overview, where to look first
- [`docs/strata.md`](docs/strata.md) — the open extension system
- [`docs/compiler-api.md`](docs/compiler-api.md) — the `&Compiler::*` surface

## Prerequisites

- [Bun](https://bun.sh/) — host runtime for the Stage 0 TS compiler
- [WABT](https://github.com/WebAssembly/wabt) — provides `wat2wasm`
- [Wasmtime](https://docs.wasmtime.dev/cli-install.html) ≥ 14 — the WASI runtime
  the bootstrap and the smoke tests run under

Quick install:

```sh
# Bun
curl -fsSL https://bun.sh/install | bash         # macOS / Linux
irm bun.sh/install.ps1 | iex                     # Windows PowerShell

# Wasmtime
curl https://wasmtime.dev/install.sh -sSf | bash # macOS / Linux
# Windows: download from https://github.com/bytecodealliance/wasmtime/releases

# WABT
brew install wabt                                # macOS
sudo apt install wabt                            # Debian / Ubuntu
# Windows: download from https://github.com/WebAssembly/wabt/releases
```

Why wasmtime: it's the WASI reference implementation. Wasmer's WASI compat
layer has known bugs at both 2.x (mapped-dir rights) and 7.x (post-`path_open`
fd corruption + Windows absolute-path stdout) that block the bootstrap
end-to-end tests.

## Build and run

```sh
git clone https://github.com/natescode/sigil.git
cd sigil
bun install

# Compile a Silicon source through the Stage 0 compiler (writes main.wat).
bun run src/sigil_cli.ts examples/demo.si

# Assemble WAT to WASM and invoke a function.
wat2wasm main.wat -o main.wasm
wasmtime --invoke add main.wasm 9 7
```

Sanity check:

```sh
bun --version          # ≥ 1.0
wasmtime --version     # ≥ 14
wat2wasm --version
bun test               # full suite, including the wasix-smoke bootstrap tests
```

## Bootstrap

```sh
bun run boot:build     # compile boot/main.si → wasm-bin/boot.{wat,wasm}
bun run stage1:build   # build wasm-bin/stage1.wasm (Silicon-in-Silicon)
bun run stage1:run examples/demo.si   # compile via stage1.wasm under wasmtime
```

Generated artifacts (`boot.wasm`, `stage1.wasm`, and test temp wasm files) live
in `wasm-bin/` and are gitignored.

## Repository layout

```
src/         Stage 0 TypeScript compiler (parser, AST, elaborator, IR, codegen)
src/strata/  Built-in Silicon strata (operators, control flow, definition kinds)
boot/        Silicon-in-Silicon bootstrap source (compiles to stage1.wasm)
scripts/     Build and run scripts (boot, stage1, run-silicon)
tests/       WASIX smoke tests, property tests, fuzz harness
examples/    Sample Silicon programs
docs/        Architecture, bootstrap plan, strata, compiler-api references
wasm-bin/    Generated wasm/wat output (gitignored)
```

## Contributing

Open an issue or PR. The Silicon grammar is intentionally frozen — new language
features ride the strata system rather than the parser. See `CLAUDE.md` →
"Adding a Language Feature" before proposing grammar changes.

## License

MIT. See [LICENSE.md](LICENSE.md).
