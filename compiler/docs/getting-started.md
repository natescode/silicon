# Getting Started with Silicon

Install the Silicon compiler (`sgl`), create a project, and run your first program
in about 15 minutes.

---

## 1. Install sgl

**macOS / Linux (curl | sh):**

```sh
curl -fsSL https://raw.githubusercontent.com/natescode/sigil/main/scripts/install.sh | sh
```

After installation, restart your shell (or run `export PATH="$PATH:~/.sgl/bin"`) and
verify:

```sh
sgl --version
```

**macOS (Homebrew):**

```sh
brew tap natescode/sigil
brew install sgl
```

**Windows:** Use the curl | sh command inside WSL2, or download a tarball from
the [GitHub Releases](https://github.com/natescode/sigil/releases) page.

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

`src/main.si` starts with a hello-world program using Silicon's WASI I/O layer:

```silicon
@use 'src/stdlib/io';

@fn main:Int := {
    &print 'Hello, Silicon!';
    0
};
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
@use 'src/stdlib/io';

@fn greet name:Str := {
    &print name
};

@fn main:Int := {
    &greet 'Silicon';
    0
};
```

Run again:

```sh
sgl run
```

---

## 8. Explore the language

| Feature | Example |
|---|---|
| Variables | `@var x:Int := 0; x = x + 1` |
| Immutable binding | `@let y:Int := 42` |
| Conditionals | `&@if x == 0, { &print 'zero' }, { &print 'nonzero' }` |
| Loops | `&@loop { &@if done, { &@break }, {}; }` |
| Pattern matching | `&@match opt, $Some v => v, $None => 0` |
| Error handling | `@let r:Result[Int, Str] := ...; &@try r` |
| Generic functions | `@fn id[T] x:T := x` |
| Sum types | `@type Shape := $Circle r:Int \| $Rectangle w:Int, h:Int` |
| Structs | `@struct Point := { x:Int, y:Int }` |
| Cleanup | `@defer { &cleanup }` |

---

## Next steps

- **Language reference:** the EBNF grammar is in `docs/grammar.ebnf`; built-in
  keywords and operators are defined as strata in `boot/strata/builtin/`.
- **Stdlib:** `src/stdlib/io.si` — `print`, `eprint`, `exit`; more modules are in `src/stdlib/`.
- **Compiler API:** `docs/compiler-as-a-service.md` — use Silicon as a library
  for IDE integrations, linters, and other tooling.
- **Strata authoring:** `docs/strata-authoring-guide.md` — add your own keywords
  and operators without modifying the grammar.
- **Issues / feedback:** https://github.com/natescode/sigil/issues
