---
title: "Platforms"
---
# Compilation Targets

Silicon compiles to two targets: **WebAssembly** (the default) and **native** via the QBE backend.  The same Silicon source works on both; the differences are in the runtime environment each target provides.

## Quick reference

| | WASM (`sgl build`) | Native (`sgl build --native`) |
|---|---|---|
| Output | `.wasm` binary | ELF / Mach-O executable |
| Toolchain | `wasmtime` to run | `qbe` + `cc` to compile, then run directly |
| I/O | WASI (`wasi_snapshot_preview1`) | libc (`puts`, `printf`, …) |
| String layout | length-prefixed | plain C string |
| `@extern` namespace | `wasi_snapshot_preview1::fd_write` etc. | `puts`, `printf`, `malloc`, … |
| Standard library | `@use 'io'` (snake_case stdlib) | `@extern` libc functions directly |
| Memory model | linear bump-allocator (`&alloc`, `@with_arena`) | same via `malloc`, or libc |

---

## WebAssembly target (default)

`sgl build` and `sgl run` compile to `.wasm` and execute under **wasmtime** (or any WASI-compatible runtime).

### I/O

There is no libc in a WASM sandbox.  All I/O goes through **WASI** (`wasi_snapshot_preview1`).  The standard library wraps this for you:

```silicon
@use 'io';

&print 'Hello, Silicon!';   # writes to stdout via WASI fd_write
```

If you need raw WASI access, declare the extern yourself:

```silicon
@extern {
    \\ wasi_snapshot_preview1::fd_write (Int, Int, Int, Int) -> Int
}
```

### String layout

WASM strings use Silicon's **length-prefixed** layout:

```
[ len: i32 (4 bytes, little-endian) ][ UTF-8 bytes ][ NUL byte ]
```

The 4-byte header lets `write_str`, `str_len`, and `str_concat` operate without scanning for a NUL.  The NUL is kept as a safety sentinel only.

This layout is what `src/stdlib/io.si` and the WASM codegen expect.  String literals in `.si` source compile to this format in the WASM data section.

---

## Native target (QBE)

`sgl build --native` (or `--release`) runs the **QBE backend**: Silicon → QBE IR → assembly → native executable via `cc`.

### Installing QBE

```sh
# Fedora / RHEL
sudo dnf install qbe

# Debian / Ubuntu
sudo apt install qbe

# macOS
brew install qbe

# Build from source (any platform)
sgl setup
```

### I/O

The native binary links against **libc** automatically (the same way any C program does).  Declare any libc function with `@extern` and call it directly:

```silicon
@extern {
    \\ puts (String) -> Int
    \\ printf (String) -> Int
}

&puts 'Hello, world!';
```

Any POSIX or libc symbol is reachable this way — `malloc`, `free`, `open`, `read`, `write`, `exit`, and so on.

### String layout

Native strings are **plain C strings**:

```
[ UTF-8 bytes ][ NUL byte ]
```

No length prefix.  String literals in `.si` source compile directly to NUL-terminated byte arrays in the data section.  The label produced for a string literal points at the first character, so passing it to `puts` or `printf` works without any offset arithmetic.

The length is found via `strlen` from libc (or by tracking it separately in your program).

### `@extern` parameter types

Use `String` for C string pointer parameters so the typechecker accepts string literals and the lowerer emits a 64-bit pointer (`l` in QBE IR):

```silicon
@extern {
    \\ puts (String) -> Int      # correct — accepts string literals
    \\ printf (String) -> Int    # correct
}
```

Using `Int` for a string parameter will cause a typecheck error when you pass a string literal.

---

## Why the string layouts differ

The length-prefix layout is a **WASM artifact**.  WASM has no libc and therefore no `strlen`.  Every string operation needs the length available without a scan.  The stdlib's `write_str` reads the 4-byte header and passes `(ptr + 4, len)` to `fd_write`.

On native, **libc is always linked**.  C strings are the universal currency of the native runtime: `puts`, `printf`, `fopen`, and every other system function expects a NUL-terminated pointer.  Storing a length prefix would mean adding 4 to every pointer before passing it to libc — wasted ceremony for no benefit.

The split is handled entirely in the lowerer; Silicon source code is identical on both targets.  A string literal `'hello'` in a `.si` file compiles to the right layout for whichever backend is active.

---

## Target-specific `@extern` patterns

### WASM — wrap WASI

```silicon
@extern {
    \\ wasi_snapshot_preview1::proc_exit (Int) -> Void
}

&wasi_snapshot_preview1::proc_exit 0;
```

Or use the stdlib which wraps this:

```silicon
@use 'io';
&exit 0;
```

### Native — call libc directly

```silicon
@extern {
    \\ exit (Int) -> Void
    \\ malloc (Int) -> Int
    \\ free (Int) -> Void
    \\ strlen (String) -> Int
}

@local n := &strlen 'hello';   # 5
```

---

## Linking against C libraries

libc is linked automatically.  To call any **other** C library (raylib, SDL,
SQLite, …), declare its functions with `@extern` and tell the linker which
library provides them.  `@extern` only declares "this symbol exists; resolve it
at link time" — it emits no import, just a `call`; the linker binds it against
the libraries you name.

### Pass linker flags on the command line

`sgl build --native` and `sgl run --release` forward cc-style linker flags:

```sh
sgl build --native game.si -lraylib -lm        # link libraylib + libm
sgl build --native game.si -L/opt/lib -lfoo    # add a search directory
sgl run   --release game.si -lraylib -lm       # build + run
```

- `-l<name>` links `lib<name>.so` (or `.a`); the `lib` prefix and `.so` suffix are implied.
- `-L<dir>` adds a library search directory (e.g. Homebrew's `/opt/homebrew/lib`).
- `--link <arg>` passes an arbitrary argument straight to the linker, e.g. `--link -Wl,-rpath,/opt/lib`.

If a library ships a pkg-config file, let it supply the flags:

```sh
sgl build --native game.si $(pkg-config --libs raylib) -lm
```

### Declare default libraries in sgl.toml

For a project, list the libraries once under `[native]` rather than repeating
them on every build:

```toml
[native]
libs      = ["raylib", "m"]     # → -lraylib -lm
link-args = ["-L/opt/lib"]      # raw cc/ld arguments
```

CLI `-l`/`-L`/`--link` flags are appended on top of the toml defaults.

### Inspecting the native pipeline

```sh
sgl build --emit-qbe game.si                          # write game.qbe (QBE IR), then stop
sgl build --native --save-temps game.si -lraylib -lm  # keep game.qbe + game.s
```

`--emit-qbe` runs only the front-end and QBE lowering, so it needs neither the
`qbe` binary nor the C libraries — handy for inspecting codegen.

See [`examples/cube.si`](../examples/cube.si) for a complete program (a rotating
raylib cube) that links this way.

---

## Choosing a target

| Use WASM when… | Use Native when… |
|---|---|
| You want sandboxed, portable execution | You need raw performance or OS access |
| You're targeting a WASI runtime (wasmtime, browser, edge) | You're building a CLI tool or system program |
| You're using the Silicon stdlib for I/O | You want direct libc / POSIX interop |
| Portability across architectures matters | You're on a single platform and want the simplest build |
