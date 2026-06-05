# greeter — a full JS-String project (bun platform)

A complete multi-file Silicon project that runs on the **bun platform** and uses
**JavaScript strings** (`JSString`) via the WASM JS String Builtins.

```
greeter/
  sgl.toml          # [build] platform = "bun"
  src/
    main.si         # entry — composes greetings, prints them
    greeting.si     # JSString helpers, pulled in via `@use 'greeting.si'`
```

## Run

```sh
cd examples/greeter
sgl run                      # platform comes from sgl.toml ([build] platform = "bun")
# or, without the project dir:
sgl run --platform=bun src/main.si
```

Expected output:

```
Hello, Silicon!
Hello, world!!!!
15
Hello
🎉
```

## What it shows

- **`sgl.toml [build] platform = "bun"`** — selects the JS host so `sgl run`
  executes in-process under Bun (with `{ builtins: ['js-string'] }`) instead of
  wasmtime, and enables the `JSString` type.
- **Multi-file project** — `main.si` pulls in `greeting.si` with `@use`.
- **`JSString`** — a JavaScript string (externref), distinct from Silicon's
  default linear-memory `String`.
- **`wasm:js-string` builtins** — `concat`, `substring`, `length`, `fromCodePoint`,
  all running host-native.
- **`JSString::fromString`** — the bridge from a linear `String` literal to a JS
  string.
- **`console::log`** (a JSString) and **`web::console_log`** (an Int) for output.

See `../../docs/js-string-builtins.md` for the full reference.
