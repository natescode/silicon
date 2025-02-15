# Sigil: The Silicon Compiler

Sigil is the official compiler for the Silicon programming language. Sigil compiles Silicon to WebAssembly (WASM). View the [Silicon language specification]().


## Installation / Setup

Sigil is currently in early alpha. To build and install:

## Tools

- [Bun](https://bun.sh/)
- [Binaryen](https://github.com/WebAssembly/binaryen)
- [Releases](https://github.com/WebAssembly/binaryen/releases)
- [WABT](https://github.com/WebAssembly/wabt)
- [Wasmer](https://docs.wasmer.io/install)


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

## Run the WASM via wazmer
wasmer run main.wasm --invoke add 9 7
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
wasmer run main.wasm --invoke add 9 7
```

## View WASM Binary
```bash
wasmer run main.wasm --invoke foo
```