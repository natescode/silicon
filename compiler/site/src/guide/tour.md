---
title: Language tour
---

# Language tour

Five minutes through every concept in Silicon. Each section links to its
reference page for the long version.

## Functions

```silicon
@fn add a:Int, b:Int := { a + b };

@fn square n:Int := { n * n };

@fn main := {
    &add (&square 3), 1
};

@export main;
```

Calls are prefix with `&`: `&add 1, 2`. Definitions use `:=`. Type
annotations follow the colon: `a:Int`.

## Types

| Surface | Notes |
|---------|-------|
| `Int` | Target-sized signed integer. `i32` on wasm32. |
| `Int32` / `Int64` | Explicit-width signed integers. |
| `u8` / `u16` / `u32` / `u64` | Unsigned. Codegen routes to `*_u` instructions. |
| `Float` | `f64`. |
| `Bool` | `i32` under the hood; `@true` / `@false`. |
| `Str` | UTF-8, length-prefixed (4-byte little-endian). |

Conversions are explicit — `&@toInt64 x`, `&@toInt x` (also handles
`Float → Int`). No implicit promotion. See
[Types reference →](/reference/types).

## Sum types

```silicon
@type Shape := $Circle r:Int | $Rect w:Int, h:Int;

@fn area s:Shape := {
    &@match s,
        $Circle r => r * r * 3,
        $Rect w h => w * h
};
```

Parametric sum types use `@type T[X] := …`. See
[`Option[T]`](/examples/sum-types) for the canonical use.

## Generics + HM-lite inference

```silicon
@fn id[T] x:T := x;

@fn pair[T] a:T, b:T := { … };

@fn main := {
    @let n:Int := &id 42;        # T = Int
    @let s:Str := &id "hello";   # T = Str
    0
};
```

No explicit `[Int]` at the call site. See
[HM-lite reference →](/reference/hm-lite).

## Structs

```silicon
@struct Point x:Int, y:Int;

@fn main := {
    @local p:Point := &Point 3, 4;
    p.x + p.y
};
```

Field syntax `p.x`. Nested structs compute their size and lay out
contiguously.

## Control flow

```silicon
@fn classify n:Int := {
    &@if n < 0, { &@return -1 };
    &@if n == 0, { &@return 0  };
    1
};

@fn sum_to n:Int := {
    @var total:Int := 0;
    @var i:Int := 1;
    &@loop i <= n, {
        total = total + i;
        i = i + 1;
    };
    total
};
```

`@return`, `@break`, `@continue` exit early. `@defer` runs LIFO at
every exit:

```silicon
@fn main := {
    &@defer { &println "bye" };
    &println "hi";
    0
};
```

## Error handling

```silicon
@fn parse_user line:Str := &Result[User, Str] {
    &@try (&parse_name line),     # propagates Err
    &@try (&parse_age line),
    &Ok (&User name age)
};
```

`Option[T]` and `Result[T, E]` are in the stdlib. `@try` is a
prefix-keyword (Silicon bans postfix operators).

## Memory

Default allocation is bump from the heap. Scoped allocation:

```silicon
@fn process data:Slice[u8] := {
    &@with_arena {
        @local tmp:Vec[Int] := &Vec::new;
        # … all allocations here go in the arena;
        # heap reset on scope exit
        &compute &tmp
    }
};
```

To keep a value past the scope, `&move_to_parent_arena value`. See
[Memory + arenas →](/guide/memory).

## Strata — adding a keyword

```silicon
@stratum MyKeyword := {
    &Compiler::register::keyword '@my_keyword';
    &Compiler::on::lower '@my_keyword', MyKeyword_lower;
};

@fn MyKeyword_lower node:Int := {
    # … build IR with &Compiler::ir::* calls
};
```

That's it. The compiler dispatches to your handler whenever `@my_keyword`
appears as a definition keyword. See
[Writing a stratum →](/guide/strata) for the full walkthrough.

## CLI

```sh
sgl init my-project              # scaffold
cd my-project
sgl run                          # compile + execute under wasmtime
sgl build                        # compile to .wasm
sgl build --release              # native via QBE
sgl build --target=wasm-gc       # opt-in WasmGC backend
sgl check                        # typecheck only
sgl fmt                          # formatter
```

## Where to next

- [Getting-started tutorial](/guide/getting-started) — the 15-minute version
- [Examples cookbook](/examples/) — ten short, runnable programs
- [Strata system](/reference/strata) — the data-driven language extension model
- [CaaS API](/reference/caas) — using Sigil as a library
