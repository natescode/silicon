---
layout: home

hero:
  name: Silicon
  text: A WebAssembly-targeting systems language where features are data.
  tagline: The compiler core never switches on keyword names. Every operator and control-flow construct is a stratum defined in Silicon source.
  actions:
    - theme: brand
      text: Get started in 15 minutes
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/NatesCode/sigil

features:
  - title: Strata 2.0
    details: '`@if`, `@loop`, `@match`, `@fn`, `@struct`, `@defer` — every keyword is a stratum in `.si` source. Add `@my_keyword` like writing a function.'
  - title: WebAssembly + Native
    details: Primary target is WAT/WASM (binaryen + wabt). Via QBE, native binaries on linux-x86_64, linux-aarch64, macos-arm64, macos-x64. Opt-in WasmGC backend.
  - title: Arenas + Rc
    details: '`with_arena { … }` scopes allocation; `move_to_parent_arena value` escapes tail-position. `Rc<T>` for shared ownership. Heap exhaustion is a clean trap.'
  - title: HM-lite inference
    details: Declared polymorphism on `@fn[T]` and `@type[T]`. No let-generalisation. Call sites infer `T` automatically. Roc-style trajectory.
  - title: Library-first compiler
    details: 'Compiler-as-a-Service: `parse`, `elaborate`, `typecheck`, `lower` are the public API. The `sgl` CLI is a thin consumer. LSP/tooling is a wrapper.'
  - title: Honest 1.0
    details: No LSP, no package registry, no incremental compile — all v1.1 work, all called out explicitly in the changelog.
---

## A five-line example

```silicon
@fn area s:Shape := {
    &@match s,
        $Circle r => r * r * 3,
        $Rect w h => w * h
};

@export area;
```

`sgl run` compiles, executes in wasmtime. `sgl build --release` produces
a native binary via the QBE backend.

## Install in 60 seconds

```sh
curl -fsSL https://raw.githubusercontent.com/NatesCode/sigil/main/scripts/install.sh | sh
sgl init hello
cd hello
sgl run
```

Continue with the [15-minute tutorial →](/guide/getting-started)
