---
title: "Language overview"
---
# An Overview of Silicon

A tour of the Silicon language, in the spirit of the
[Go Tour](https://go.dev/tour/) and the
[Odin Overview](https://odin-lang.org/docs/overview/). It moves from
"hello world" through types, control flow, data, generics, error handling,
memory, the standard library, platforms, and Silicon's metaprogramming system,
**strata**.

Silicon compiles to WebAssembly (and, via QBE, to native binaries). Everything
below runs with the `sgl` compiler — install it from
[Getting Started](/guide/getting-started).

> Convention: a value binding is **bare** (`name := value`, immutable); `@mut`
> marks a mutable binding, `@fn` a function, and `@type` a type. Calls are
> parenthesised (`print(x)`), including built-ins like `@if(…)`/`@loop(…)`.
> A `\\ name (Types) -> Ret` line above a definition is its **signature line**.

---

## 1. Hello, world

```silicon
@use 'io';

@fn main := {
    print('Hello, Silicon!');
    0
};
main();
```

```sh
sgl run hello.si        # Hello, Silicon!
```

`@use 'io'` pulls in the standard-library I/O module. `print` writes a line to
stdout. The top-level `main();` is the program's entry point.

The toolchain:

```sh
sgl init my-project     # scaffold sgl.toml + src/main.si
sgl run                 # compile to wasm + execute (wasmtime)
sgl build               # produce a .wasm
sgl build --native      # produce a native binary (via QBE)
sgl check               # type-check only, with caret diagnostics
```

---

## 2. Comments

```silicon
# Line comments start with '#'.
## Doc comments start with '##' and attach to the following definition.
```

---

## 3. Values and basic types

| Type | Description | Literals |
|------|-------------|----------|
| `Int` | target-sized signed integer (`i32` on wasm32) | `0`, `42`, `0 - 7` |
| `Int64` | 64-bit signed integer | `@toInt64(42)` |
| `Float` | 32-bit float (`f32`) | `3.14`, `0.0` |
| `Bool` | boolean | `@true`, `@false` |
| `String` | length-prefixed UTF-8 | `'hello'` |

Conversions are explicit — there is no implicit numeric coercion:

```silicon
n := @toInt(3.75);        # Float -> Int (truncates) = 3
f := @toFloat(10);        # Int -> Float = 10.0
big := @toInt64(1);       # Int -> Int64
```

---

## 4. Variables and bindings

Silicon has two value bindings, distinguished by mutability:

```silicon
PI := 3.14159;               # immutable — a module constant (cannot be reassigned)
@mut count := 0;             # mutable
count = count + 1;           # reassign — only @mut can be reassigned
```

A bare `name := value` is an immutable binding — a module constant at the top
level, an immutable local inside a function. `@mut name := value` is mutable (a
module variable at the top level, a mutable local inside a function).
**Binding types are always inferred** — there is no type annotation on a
variable. To pin types, annotate the *function* with a `\\` signature line:

```silicon
\\ area (Int, Int) -> Int
@fn area w, h := { w * h };
```

---

## 5. Operators

```silicon
+  -  *  /  %                    # arithmetic (Int and Float)
== != < <= > >=                  # comparison -> Bool
||                               # logical OR
++                               # string concatenation
```

Operators dispatch on operand type: `+` on two `Float`s emits `f32.add`, on two
`Int`s `i32.add`. Both operands must be the same type. Logical AND is written as
nested `@if` (there is no `&&` operator).

```silicon
msg := 'foo' ++ '-' ++ int_to_str(99);     # "foo-99"
```

---

## 6. Control flow

`@if` is an expression-or-statement: `@if(cond, { then }, { else })`.

```silicon
@if(x == 0, { print('zero') }, { print('nonzero') });
```

`@loop` is the one loop keyword; it dispatches on the number of operands before
the `{ body }` block — a bare block loops forever, one operand is a `while`
condition, and two or three iterate over a `lo..hi` range or a `Vec` (`@break()`
exits early):

```silicon
@mut i := 0;
@loop(i < 10, { print_int(i); i = i + 1 });   # while

@loop(v, 0..10, { print_int(v) });            # half-open range (10 excluded)
@loop(i, v, xs, { … });                       # Vec: index + element
```

See [Conditions & loops](https://silicon-lang.org/examples/control-flow) and
ADR 0016 for every form and the v1 scope.

`@return` returns early from a function:

```silicon
\\ safe_div (Int, Int) -> Int
@fn safe_div x, y := {
    @if(y == 0, { @return(0) }, {});
    x / y
};
```

`@match` destructures sum types (see §9).

---

## 7. Functions

```silicon
\\ add (Int, Int) -> Int
@fn add a, b := { a + b };

s := add(2, 3);                  # call with parens, args comma-separated
```

A single-expression body needs no braces:

```silicon
\\ square (Int) -> Int
@fn square n := n * n;
```

Export functions to the host with `@export`, and import host functions with
`@extern`:

```silicon
@export add;

\\ @extern puts (String) -> Int;
puts('from C');
```

---

## 8. Structs

```silicon
@type Point := { x Int, y Int };

@fn main := {
    p := Point(3, 4);            # construct
    print_int(p.x + p.y);        # field access -> 7
    0
};
```

---

## 9. Sum types, enums, and pattern matching

A **sum type** has variants, each marked with `$` and an optional payload:

```silicon
@type Shape := $Circle r Int | $Square s Int;

\\ size (Shape) -> Int
@fn size sh := {
    @match(sh,
        $Circle r => r,
        $Square s => s)
};

size(Circle(10));               # constructors are Circle / Square
```

An **enum** is a set of payload-free variants:

```silicon
@type Color := $Red | $Green | $Blue;

\\ code (Color) -> Int
@fn code c := {
    @match(c,
        $Red   => 1,
        $Green => 2,
        $Blue  => 3)
};
```

Pattern alternation shares a body across variants: `$Red | $Green => 1`.

---

## 10. Generics

Silicon uses **HM-lite** — Hindley–Milner inference restricted to declared
polymorphism (`@fn[T]`, `@type[T]`). Call sites infer the type arguments; no
explicit `[Int]` needed.

```silicon
\\ id[T] (T) -> T
@fn id x := x;

id(99);                          # T inferred as Int
id('hi');                        # T inferred as String
```

Parametric sum types power `Option` and `Result`:

```silicon
@type Option[T] := $Some value T | $None;
```

---

## 11. Error handling — Option and Result

No exceptions. Absence is `Option[T]`; fallible results are `Result[T, E]`.

```silicon
@use 'option';
@use 'result';

picked := option_unwrap_or(Some(42), 0);     # 42
fallen := option_unwrap_or(None(), 7);       # 7

r := Ok(42);
v := result_unwrap_or(r, 0);                  # 42
```

Helpers: `option_is_some`, `option_is_none`, `result_is_ok`, `result_is_err`.

---

## 12. Memory

The default allocator is a bump allocator — fast, never frees. Fine for
run-and-exit programs. For long-running loops (servers, REPLs), wrap
per-iteration work in `@with_arena({ … })` so each iteration's allocations are
reclaimed, and use `@move_to_parent_arena(value)` to keep a value the parent
scope needs:

```silicon
response := @with_arena({
    body := build_response(req);
    @move_to_parent_arena(body)
});
```

`Rc[T]` (reference counting) is available via `@use 'rc'`. See
[`memory.md`](/guide/memory) for the full model.

---

## 13. The standard library

The stdlib wraps low-level WASI and intrinsics behind ergonomic `snake_case`
functions, so basic programs read like a high-level language. Full reference:
[`stdlib.md`](/guide/stdlib).

```silicon
@use 'io';      # print, println, print_int/float/bool, eprint, read_line, exit
@use 'num';     # int_to_str, str_to_int, int_abs/min/max/clamp/pow, float_*
@use 'str';     # str_eq, str_contains, str_slice, str_repeat, str_index_of, …
@use 'mem';     # align_up, mem_fill, mem_eq  (portable; also wasm-gc)
@use 'heap';    # heap_align  (bump-pointer alignment; wasm-mvp only)
```

A taste:

```silicon
@use 'io';
@use 'str';

@fn main := {
    name := read_line();                             # input
    print('Hello, ' ++ name ++ '!');
    print_int(str_byte_len(name));
    @if(str_contains(name, 'a'), { print('has an a') }, {});
    0
};
main();
```

Data structures: `vec` (`Vec[Int]`), `hashmap`, `slice`, plus `option` /
`result`.

---

## 14. Platforms

A **platform** is the host a program runs on — orthogonal to the wasm
memory-model `--target` (`wasm-mvp` vs `wasm-gc`). Choose it with `--platform`
or `sgl.toml [build] platform`.

| Platform | How | Output | Strings |
|----------|-----|--------|---------|
| **native / WASI** (default) | `sgl run` (wasmtime) / `sgl build --native` (QBE) | `@use 'io'` → `print`, `read_line` | linear-memory `String` |
| **bun** | `sgl run --platform=bun` | `console::log`, `web::console_log_f` | `JSString` + `String` bridge |
| **web** | `sgl run --platform=web` (browser) | `web::canvas_*`, `web::set_html` | `JSString` + `String` |

The pure stdlib modules (`mem`, `num`, `str`) compile on **all** platforms;
only I/O differs. On the JS host, JavaScript strings are the `JSString` type
(WASM JS String Builtins) with a `String` ↔ `JSString` bridge — see
[`js-string-builtins.md`](https://github.com/NatesCode/silicon/blob/main/docs/js-string-builtins.md).

```silicon
# bun platform — the portable stdlib + the JS console
@use 'num';
web::console_log_str(int_to_str(int_pow(2, 16)));     # 65536
```

---

## 15. Strata — Silicon's metaprogramming

Silicon's grammar is intentionally tiny and stable. Almost every "keyword" and
"operator" — `@if`, `@loop`, `@mut`, `+`, `==`, `++` — is **not** baked into the
grammar. They are defined as **strata**: data-driven Silicon declarations,
loaded into the compiler, that say how a construct lowers.

```silicon
# The '++' string-concat operator is a stratum:
@stratum Concat := {
    Compiler::register::operator('++');
    Compiler::on::lower('++', Concat_lower);
};
```

This means you can add your own keywords and operators **without touching the
grammar or the compiler's TypeScript** — you write a stratum that calls
`Compiler::*(…)` to register and lower the new construct. The built-in language is itself a library of
strata under `src/strata/`. See the
[Strata authoring guide](/reference/strata-authoring) and
[`strata.md`](/reference/strata).

Why this matters: it keeps the core language small and bootstrappable while
letting the surface syntax grow as a library — the same philosophy as the
standard library wrapping WASI.

---

## Where to go next

- **[Getting Started](/guide/getting-started)** — install + first project.
- **[Standard Library](/guide/stdlib)** — every shipped module.
- **[Memory model](/guide/memory)** — arenas, escape, `Rc[T]`.
- **[JS String Builtins](https://github.com/NatesCode/silicon/blob/main/docs/js-string-builtins.md)** — the JS-host string story.
- **[Strata authoring](/reference/strata-authoring)** — add your own syntax.
- **[Grammar](/reference/grammar)** — the authoritative EBNF.
- **Examples** — [`examples/`](https://github.com/NatesCode/silicon/tree/main/examples): fizzbuzz, calculator, strings,
  floats, web letters, and the bun/web demos.
