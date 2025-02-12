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

[Binaryen](https://github.com/WebAssembly/binaryen)
[Releases](https://github.com/WebAssembly/binaryen/releases)
[WABT](https://github.com/WebAssembly/wabt)


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