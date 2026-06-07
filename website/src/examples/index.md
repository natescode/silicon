---
title: Examples cookbook
---

# Examples cookbook

Short, runnable Silicon programs grouped by what they teach. Each page
is self-contained — copy the source into `src/main.si`, `sgl run`.

**Basics** — start here.

| Example | Teaches |
|---------|---------|
| [Hello world](/examples/hello) | Project scaffold, `@fn main`, `@use 'io'` |
| [Variables](/examples/variables) | bare (immutable) vs `@mut` (mutable), inference |
| [Functions](/examples/functions) | `@fn`, `\\` signature lines, parenthesised calls, `@export` |
| [Conditions & loops](/examples/control-flow) | `@if`, `@loop`, `@return`, FizzBuzz |
| [Sum types + `@match`](/examples/sum-types) | `@type`, variant constructors, arm-expression form |
| [Generics](/examples/generics) | `@fn[T]`, parametric sum types, HM-lite inference |
| [Error handling with `@try`](/examples/try) | `Result[T,E]`, prefix-keyword unwrap shorthand |
| [First-class functions](/examples/first-class-fns) | Function references, `call_indirect` |

**Systems & platforms**

| Example | Teaches |
|---------|---------|
| [C interop (`@extern`)](/examples/native) | `@extern`, libc, `sgl build --native` |
| [Rotating cube (raylib FFI)](/examples/cube) | `\\ @extern`, native lib linking, scalar-only FFI |
| [Arena allocation](/examples/arena) | `with_arena`, parent-arena escape |
| [Rc smart pointer](/examples/rc) | Shared ownership, refcount semantics |

**Metaprogramming**

| Example | Teaches |
|---------|---------|
| [Writing a stratum](/examples/stratum) | Adding a keyword via `@stratum` |
| [Strata as design solvent](/examples/dsl) | Building a small DSL with strata |

## How to run any example

```sh
sgl init scratch
cd scratch
# paste the example body into src/main.si
sgl run
```

If an example needs the standard library, add `@use 'io';` (or `'num'`, `'str'`,
…) at the top — `sgl init` already wires `io` in for you.

## Want more?

The full test suite under
[`src/`](https://github.com/NatesCode/silicon/tree/main/src) is the
biggest corpus of real Silicon. Look at any `*.test.ts` — most embed
representative programs as backtick-delimited strings.
