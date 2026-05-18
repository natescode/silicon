# Sigil: The Silicon Compiler

Sigil is the official compiler for the Silicon programming language. Sigil compiles Silicon to WebAssembly (WASM). View the [Silicon language specification]().

**Roadmap:** Sigil is in Stage 0 (TypeScript on Bun). The self-hosting plan — Silicon compiling Silicon, running under wasmtime/WASI — lives in [`docs/bootstrap-plan.html`](docs/bootstrap-plan.html). The in-flight Stage 0 hardening work that precedes it is in [`docs/stage0-cleanup-plan.html`](docs/stage0-cleanup-plan.html). Architecture and contributor entry points: [`CLAUDE.md`](CLAUDE.md), [`docs/strata.md`](docs/strata.md), [`docs/compiler-api.md`](docs/compiler-api.md).


## Installation / Setup

Sigil is currently in early alpha. To build and install:

## Tools

- [Bun](https://bun.sh/) — the host runtime for the Stage 0 TS compiler.
- [WABT](https://github.com/WebAssembly/wabt) — `wat2wasm` for assembling emitted WAT into `.wasm`.
- [Wasmtime](https://docs.wasmtime.dev/cli-install.html) — the WASI runtime the bootstrap (`stage1.wasm`) and the `wasix-smoke` tests run under.  Wasmtime is the WASI reference implementation; wasmer's WASI compat layer has known bugs at both 2.x (mapped-dir rights) and 7.x (post-`path_open` fd state, Windows absolute-path stdout) that block our Phase 4b end-to-end test.

Quick install (per-platform; see each tool's docs for alternatives):

```sh
# Bun
curl -fsSL https://bun.sh/install | bash         # macOS/Linux
irm bun.sh/install.ps1 | iex                     # Windows PowerShell

# Wasmtime (cross-platform installer)
curl https://wasmtime.dev/install.sh -sSf | bash # macOS/Linux
# Windows: download from https://github.com/bytecodealliance/wasmtime/releases
#   (look for `wasmtime-vXX.Y.Z-x86_64-windows.zip`) and add wasmtime.exe to PATH.

# WABT — provides wat2wasm
brew install wabt                                # macOS
sudo apt install wabt                            # Debian / Ubuntu
# Windows: download from https://github.com/WebAssembly/wabt/releases
```

```sh
# Clone the repository
git clone https://github.com/your-org/sigil.git
cd sigil
bun install

# Compile and Run
## Run the compiler
bun run index.ts

## Convert WAT (WASM Text) to WASM binary
wat2wasm main.wat -o main.wasm

## Run the WASM via wasmtime
wasmtime --invoke add main.wasm 9 7
```

Sanity check after install:

```sh
bun --version          # ≥ 1.0
wasmtime --version     # ≥ 14 (anything older is untested with the bootstrap)
wat2wasm --version
bun test               # full suite, including the wasix-smoke bootstrap tests
```

## Getting Started
Create a simple Silicon program (`hello.sil`):
```sil
@fn main = {
    &print("Hello, Silicon!");
};
```
Compile it to WASM:
```sh
sigil compile hello.sil -o hello.wasm
```
Run it in a JavaScript environment:
```js
const fs = require("fs");
const wasmBuffer = fs.readFileSync("hello.wasm");
WebAssembly.instantiate(wasmBuffer).then(({ instance }) => {
    instance.exports.main();
});
```

## Contributing
Contributions are welcome! Please follow the [contribution guidelines](CONTRIBUTING.md) and open an issue or pull request.

## License
Sigil is licensed under the MIT License. See [LICENSE](LICENSE) for details.

## Contact
For discussions and updates, join the Silicon community:
- **Discord**: [Invite Link]
- **GitHub Issues**: [Report bugs or suggest features](https://github.com/your-org/sigil/issues)
- **Website**: [Coming soon]




# sigil

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.0.29. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.

## Tools


## WAT 2 WASM
Currently, Sigil only compiles to WAT (Web Assembly text format)
To convert use `wat2wasm` CLI.

```bash
brew install binaryen
brew install wabt
wat2wasm main.wat -o main.wasm
```

## Use in JavaScript

```javascript
const wasmInstance =
      new WebAssembly.Instance(wasmModule, {});
const { main } = wasmInstance.exports;
console.log(main());
```


## Compile, Build, Run

```bash
bun run index.ts
wat2wasm main.wat -o main.wasm
wasmtime --invoke add main.wasm 9 7
```

## View WASM Binary
```bash
wasmtime --invoke foo main.wasm
```