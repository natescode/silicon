# Silicon examples

Organized by **platform** — the host a program runs on. Platform is orthogonal
to `--target` (the wasm memory model); pick it with `--platform` or
`sgl.toml [build] platform`.

## Bun / web platform — JS host (JS String Builtins)

`--platform=bun` runs in-process under Bun with the WASM `wasm:js-string`
builtins; `--platform=web` builds for the browser. These use the `JSString` type
(JavaScript strings, externref) and the `console` / `web` modules.

| Example | Run | Shows |
|---|---|---|
| [greeter/](greeter/) | `cd greeter && sgl run` | **Full project** — `sgl.toml`, multi-file `@use`, JSString + console |
| [js_string_demo.si](js_string_demo.si) | `sgl run --platform=bun examples/js_string_demo.si` | JSString basics — `fromCodePoint`, `concat`, `console::log` |
| [jsstring_ops.si](jsstring_ops.si) | `sgl run --platform=bun examples/jsstring_ops.si` | JSString builtins — `length`, `charCodeAt`, `substring`, `equals`, the `String` bridge |
| [charcode_array.si](charcode_array.si) | `sgl run --platform=bun examples/charcode_array.si` | `CharCodeArray` (WASM-GC `array i16`) ↔ JSString via `fromCharCodeArray`/`intoCharCodeArray` |
| [web_math.si](web_math.si) | `sgl run --platform=bun examples/web_math.si` | `web::math_*` (the JS `Math` object) |
| [web_letters_playground.si](web_letters_playground.si) | browser playground | Walk a string as bytes (browser/canvas) |

> Under the headless bun runner you have `console`, `JSString`, the
> `String`↔`JSString` bridge, and `web::math_*` / `web::console_*`.  `web::canvas_*`
> and DOM functions are **browser-only** (use the playground).

## Native / WASI platform

The default. `sgl run` executes under wasmtime (WASI); `sgl run --native`
compiles to a native executable via QBE. Uses linear-memory `String` and
`@use 'io'` for output.

| Example | Run | Shows |
|---|---|---|
| [hello_native.si](hello_native.si) | `sgl run --native examples/hello_native.si` | Native hello world via an `@extern` |
| [delfina.si](delfina.si) | `sgl run examples/delfina.si` | `@use 'io'` → `&print` to stdout (WASI) |
| [web_letters_cli.si](web_letters_cli.si) | `sgl run examples/web_letters_cli.si` | String iteration via `@use 'io'` |

## Library examples (no entry point)

| Example | Shows |
|---|---|
| [demo.si](demo.si) | Sum types, pattern matching, `@export` |
| [cube.si](cube.si) | 3D math, loops, records |

See [docs/js-string-builtins.md](../docs/js-string-builtins.md) for the JSString
reference and [docs/README.md](../docs/README.md) for the full doc index.
