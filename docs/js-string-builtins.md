# JS String Builtins & the web/bun platform

Silicon can target a **JavaScript host** (browser or Bun) and use the WebAssembly
**JS String Builtins** (`wasm:js-string`) — the host provides native JavaScript
string operations to the module. This is opt-in and additive: the default
linear-memory UTF-8 `String` and the native/WASI paths are unchanged.

## The `JSString` type

`JSString` is a handle to a *JavaScript* string, represented as `externref` at
the WASM level (distinct from `String`, which is an `i32` pointer into linear
memory). It is only available under `--platform=web` or `--platform=bun`; using
it on `native` is a compile error.

```silicon
\\ main () -> Void
@fn main := {
    \\ hi JSString
    @local hi := &JSString::concat
        (&JSString::fromCodePoint 72),    # 'H'
        (&JSString::fromCodePoint 105);   # 'i'
    &console::log hi
};
&main;
```

```sh
sgl run --platform=bun examples/js_string_demo.si    # → Hi!
```

## Selecting the platform

Orthogonal to `--target` (the wasm memory model: `host` | `wasix` | `wasm-gc`):

| | values | how |
|---|---|---|
| `--platform` | `native` (default) · `web` · `bun` | CLI flag |
| `sgl.toml` | `[build] platform = "bun"` | persistent default |

Under `web`/`bun` the module exports `_start`; `sgl run --platform=bun` executes
it **in-process under Bun's `WebAssembly`** with `{ builtins: ['js-string'] }`
(wasmtime can't provide the builtins). The browser playground uses the same
opt-in.

## Operations

`src/strata/modules/JSString.si` — the standardized `wasm:js-string` builtins:
`length`, `charCodeAt`, `codePointAt`, `equals`, `compare`, `test`, `concat`,
`substring`, `fromCharCode`, `fromCodePoint`. Lengths/indices are UTF-16 code
units (JS semantics).

**Bridge to `String`** (host-provided, module `js-bridge`):
`&JSString::fromString s` (linear `String` → JS string) and
`&JSString::toString js` (JS string → fresh linear `String`).

**`CharCodeArray`** — a WASM-GC `(array (mut i16))` of UTF-16 code units, for the
two array builtins. `&JSString::codeArray n` allocates one; `setCode`/`getCode`/
`codeLen` read & write it (inline `array.*` instructions). `&JSString::
fromCharCodeArray a, start, end` builds a JS string from a slice; `&JSString::
intoCharCodeArray s, a, start` copies a JS string's code units into the array and
returns the count. These run host-native under the bun runner — GC types coexist
with the linear-memory model in the same module. (`examples/charcode_array.si`.)

## Reaching other Browser/Bun APIs

The host-import foundation is general: declare an externref-typed `@extern` and
provide the implementation in the host glue (`cli/src/host/js-host.ts` for Bun,
`playground/playground/web-env.js` for the browser). `console::log/error` ship as
a base surface. **Async APIs (`fetch`/Promise) are a deferred follow-on** — the
externref mechanism enables them, but the await/callback design is not yet built.
