---
title: "Getting started"
---
# Getting Started with Silicon

Install the Silicon compiler (`sgl`), create a project, and run your first program
in about 15 minutes.

---

## 1. Install sgl

**macOS / Linux (curl | sh):**

```sh
curl -fsSL https://raw.githubusercontent.com/natescode/silicon/main/scripts/install.sh | sh
```

After installation, restart your shell (or run `export PATH="$PATH:~/.sgl/bin"`) and
verify:

```sh
sgl --version
```

**macOS (Homebrew):**

```sh
brew tap natescode/silicon
brew install sgl
```

**Windows:** Use the curl | sh command inside WSL2, or download a tarball from
the [GitHub Releases](https://github.com/natescode/silicon/releases) page.

---

## 2. Create a project

```sh
sgl init hello
cd hello
```

This creates:

```
hello/
├── sgl.toml        # project manifest
└── src/
    └── main.si     # entry point
```

`src/main.si` starts with a hello-world program using Silicon's standard
library (`@use 'io'` — the stdlib wraps WASI behind ergonomic `snake_case`
helpers):

```silicon
@use 'io';

@fn main := {
    print('Hello, Silicon!');
    0
};

main();
```

---

## 3. Run the program

```sh
sgl run
```

Output:

```
Hello, Silicon!
```

`sgl run` compiles to WebAssembly and executes via `wasmtime`.  If wasmtime is
not installed, follow the prompt — `sgl setup` can install it for you.

---

## 4. Type-check

```sh
sgl check
```

Prints diagnostics (with caret rendering) on any type errors, or exits 0 if
everything is clean.

---

## 5. Build a .wasm binary

```sh
sgl build
```

Produces `hello.wasm` in the project directory.  Run it with any WASI-compatible
runtime:

```sh
wasmtime hello.wasm
```

---

## 6. Compile to a native executable (optional)

If you have QBE installed (`sgl setup` can install it), compile to a native binary:

```sh
sgl build --native       # produces ./hello
./hello
```

Or use `--release` (alias for `--native`):

```sh
sgl run --release
```

---

## 7. Write a function

Open `src/main.si` and add a function:

```silicon
@use 'io';

\\ greet (String) -> Int
@fn greet name := {
    print('Hello, ' ++ name ++ '!')
};

@fn main := {
    greet('Silicon');
    0
};

main();
```

Run again:

```sh
sgl run
```

---

## 8. Explore the language

For the full tour — types, control flow, structs, sum types, generics, error
handling, the standard library, platforms, and strata — read the
[**Language Overview**](/guide/overview). A quick reference:

| Feature | Example |
|---|---|
| Variables | `@mut x := 0; x = x + 1` |
| Immutable binding | `y := 42` |
| Conditionals | `@if(x == 0, { print('zero') }, { print('nonzero') })` |
| Loops | `@loop({ @if(done, { @break() }, {}); })` |
| Pattern matching | `@match(opt, $Some v => v, $None => 0)` |
| Error handling | `r := ...; @try(r)` |
| Generic functions | `\\ id[T] T -> T` / `@fn id x := x` |
| Sum types | `@type Shape := $Circle r Int \| $Rectangle w Int, h Int` |
| Structs | `@type Point := { x Int, y Int }` |
| Cleanup | `@defer({ cleanup() })` |

---

## Long-running programs (servers, REPLs, watchers)

The default bump allocator never frees — fine for `sgl run main.si` and
exit, but a one-way ratchet for anything in a loop. Wrap per-iteration
work in `@with_arena({ … })` so per-request allocations are freed when
the iteration ends; use `@move_to_parent_arena(value)` in tail position
when the iteration produces a value the parent scope keeps:

```silicon
\\ handle_loop () -> Int
@fn handle_loop := {
    @mut i := 0;
    @loop(i < 1000000, {
        response := @with_arena({
            body := build_response(i);
            @move_to_parent_arena(body)
        });
        send(response);
        i = i + 1;
    });
    0
};
```

See [`docs/memory.md`](/guide/memory) for the full picture: rules, type
restrictions, the `--max-heap=N` flag for heap-exhaustion testing, and
the v1.1 roadmap.

---

## Next steps

- **Language overview:** [`docs/overview.md`](/guide/overview) — the full tour.
- **Standard library:** [`docs/stdlib.md`](/guide/stdlib) — `io` (`print`,
  `print_int`, `read_line`, …), `num`, `str`, `mem`, and the data structures.
- **Language reference:** the EBNF grammar is in `docs/grammar.ebnf`; built-in
  keywords and operators are defined as strata in `src/strata/`.
- **Memory model:** `docs/memory.md` — arenas, parent-arena escape, the
  v1.1 GC outlook.
- **Compiler API:** `docs/compiler-as-a-service.md` — use Silicon as a library
  for IDE integrations, linters, and other tooling.
- **Strata authoring:** `docs/strata-authoring-guide.md` — add your own keywords
  and operators without modifying the grammar.
- **Issues / feedback:** https://github.com/natescode/silicon/issues
