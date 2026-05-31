---
title: Hello world
---

# Hello world

The smallest runnable Silicon program.

```sh
sgl init hello
cd hello
sgl run
# → Hello, Silicon!
```

What `sgl init` scaffolded for you:

```silicon
# src/main.si
@use 'stdlib/io.si';

@fn main := {
    &println "Hello, Silicon!";
    0
};

@export main;
```

`sgl run` compiled to WAT, assembled to `.wasm`, and ran under
`wasmtime`. The exit code came from the value `main` returned (`0`).

## What just happened

1. `sgl.toml` declared the project entry (`src/main.si`).
2. The compiler resolved the `@use` to bring in `println` (which wraps
   WASI `fd_write`).
3. `@fn main := { … }` is the entry point because it's `@export`ed
   under the name `main` — WASI's start hook.
