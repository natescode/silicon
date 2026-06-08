---
layout: home

hero:
  name: Silicon
  text: A systems language built for WebAssembly.
  tagline: Zig-level control, ML-level ergonomics (sum types, pattern matching, inference), and a gradual memory model that's no-GC when you need speed and garbage-collected (wasm-gc) when you don't — with first-class JavaScript/host interop.
  actions:
    - theme: brand
      text: Get started in 15 minutes
      link: /guide/getting-started
    - theme: alt
      text: Why Silicon?
      link: /guide/positioning
    - theme: alt
      text: View on GitHub
      link: https://github.com/NatesCode/silicon

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
  - title: Honest 0.1
    details: No package registry, no incremental compile — all later work, all called out explicitly in the changelog.
---

## A small example

```silicon
@type Shape := $Circle r Int | $Square s Int;

\\ size (Shape) -> Int
@fn size sh := {
    @match(sh,
        $Circle r => r,
        $Square s => s)
};

@export size;
```

Types live on a `\\` signature line, not inline; sum-type variants are
constructed by calling the generated constructor (`Some(x)`) and destructured by `@match`.

`sgl run` compiles, executes in wasmtime. `sgl build --release` produces
a native binary via the QBE backend.

## Install in 60 seconds

```sh
curl -fsSL https://raw.githubusercontent.com/NatesCode/silicon/main/scripts/install.sh | sh
sgl init hello
cd hello
sgl run
```

Continue with the [15-minute tutorial →](/guide/getting-started)
