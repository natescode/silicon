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
@fn main := {
    print('Hello, Silicon!');
    0
};

main();
```

`sgl run` compiled to WAT, assembled to `.wasm`, and ran under `wasmtime`. The
exit code came from the value `main` returned (`0`).

## What just happened

1. `sgl.toml` declared the project entry (`src/main.si`).
2. `print` writes a line to stdout (wrapping WASI `fd_write`). Strings are single-quoted.
3. The top-level `main();` runs the program.

## Next

- [Variables](/examples/variables) — bare immutable bindings, `@mut` for mutable.
- [Functions](/examples/functions) — `@fn` and `\\` signature lines.
- [Conditions & loops](/examples/control-flow) — `@if`, `@loop`, `@return`.
