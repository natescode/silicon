# Sigil — the Silicon compiler

Sigil compiles the **Silicon** programming language to WebAssembly (WAT/WASM).
The compiler is itself written in Silicon and ships as a single
self-contained `stage1.wasm` you can run under any WASI runtime.

**Status:** 100% self-hosted.  The repository contains no TypeScript, no
Bun, no Node — building Sigil from source needs only `wasmtime`,
`wat2wasm`, and a POSIX shell (or PowerShell on Windows).
`./build.sh check` confirms `stage1.wasm` recompiles its own source to
a byte-identical fixed point.

Architecture, the strata extension system, and the compiler API surface live in:

- [`CLAUDE.md`](CLAUDE.md) — pipeline overview, where to look first
- [`docs/strata.md`](docs/strata.md) — the open extension system
- [`docs/compiler-api.md`](docs/compiler-api.md) — the `&Compiler::*` surface
- [`docs/test-bootstrapped-compiler.html`](docs/test-bootstrapped-compiler.html)
  — step-by-step testing guide

## Prerequisites

- [Wasmtime](https://docs.wasmtime.dev/cli-install.html) ≥ 14 — the WASI
  runtime stage1.wasm runs under
- [WABT](https://github.com/WebAssembly/wabt) — provides `wat2wasm`
  (auto-fetched to `./bin/` via `scripts/install-wat2wasm.{sh,ps1}` if
  you'd rather not install system-wide)

Quick install:

```sh
# Wasmtime
curl https://wasmtime.dev/install.sh -sSf | bash # macOS / Linux
# Windows: download from https://github.com/bytecodealliance/wasmtime/releases

# WABT (system-wide)
brew install wabt                                # macOS
sudo apt install wabt                            # Debian / Ubuntu
# Windows: download from https://github.com/WebAssembly/wabt/releases

# WABT (project-local — no admin needed)
./scripts/install-wat2wasm.sh                    # bash; fetches to ./bin/
.\scripts\install-wat2wasm.ps1                   # PowerShell
```

Why wasmtime: it's the WASI reference implementation. Wasmer's WASI compat
layer has known bugs at both 2.x (mapped-dir rights) and 7.x (post-`path_open`
fd corruption + Windows absolute-path stdout) that broke the bootstrap.

## Build and test

```sh
git clone https://github.com/natescode/sigil.git
cd sigil

./build.sh check        # rebuild stage1.wasm; verify byte-equal self-host
./test.sh               # run the 20-test boot/tests/* suite
```

PowerShell equivalent on Windows: `.\build.ps1 check`.  (test.sh is
bash-only today; WSL or Git Bash works on Windows.)

## Compile a Silicon program

```sh
wasmtime wasm-bin/stage1.wasm < my_program.si > my_program.wat
wat2wasm my_program.wat -o my_program.wasm
wasmtime my_program.wasm
```

Multi-file program with `@use` deps?  Use the path form so stage1's
in-Silicon `@use` resolver walks the dependency graph:

```sh
wasmtime --dir ./src::src wasm-bin/stage1.wasm src/main.si > main.wat
```

Opt into the Silicon-side typechecker:

```sh
wasmtime wasm-bin/stage1.wasm --typecheck < my_program.si > my_program.wat
```

Diagnostics go to stderr; the build continues regardless (warn-only mode).

## Editing a built-in stratum

Built-in operators / keywords live in `boot/strata/builtin/*.si`.  After
editing one, regenerate the embedded bundle that `stage1.wasm` carries
inline:

```sh
./scripts/regen-embedded-bundle.sh           # bash
.\scripts\regen-embedded-bundle.ps1          # PowerShell
```

Then `./build.sh` and the change is live in the next compile.

## Repository layout

```
boot/                  Silicon-in-Silicon compiler source (compiles to stage1.wasm)
boot/strata/builtin/   Built-in Silicon strata — operators, control flow, definition kinds
boot/types/            Typechecker — SiliconType, errors, intrinsic sigs, checkNode walk
boot/tests/            Silicon-side test fixtures (driven by test.sh)
scripts/               Shell + PowerShell install/regen scripts
build.sh / build.ps1   Build pipeline (rebuilds stage1.wasm via the existing seed)
test.sh                Test runner
docs/                  Architecture, plans, strata, compiler-api, test guide
wasm-bin/              Generated wasm/wat.  stage1.wasm is checked in as the seed.
bin/                   wat2wasm fetched by scripts/install-wat2wasm.{sh,ps1}
```

## Contributing

Open an issue or PR. The Silicon grammar is intentionally frozen — new
language features ride the strata system rather than the parser. See
`CLAUDE.md` → "Adding a Language Feature" before proposing grammar
changes.

## License

MIT. See [LICENSE.md](LICENSE.md).
