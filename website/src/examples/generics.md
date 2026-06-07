---
title: Generics
---

# Generics + HM-lite inference

Declare a type parameter in brackets on the signature line and the `@fn`. The
call site infers it — no explicit `[Int]` needed:

```silicon
\\ id[T] (T) -> T
@fn id x := x;

@fn main := {
    n := id(42);        # T = Int — inferred
    print_int(n);       # 42
    0
};
main();
```

Silicon uses **HM-lite** — Hindley–Milner restricted to declared polymorphism
on `@fn[T]` and `@type[T]`, with no let-generalisation.

## Parametric sum types

The standard library's `Option[T]` is a parametric sum type. `@use 'option'` to
get it and its helpers:

```silicon
@fn main := {
    picked := option_unwrap_or($Some 7, 0);    # T = Int → 7
    fallen := option_unwrap_or($None, 99);     # T = Int → 99
    print_int(picked);
    print_int(fallen);
    0
};
main();
```

Defining your own:

```silicon
@type Option[T] := $Some value T | $None;

\\ unwrap_or[T] (Option[T], T) -> T
@fn unwrap_or opt, dflt := {
    @match(opt,
        $Some v => v,
        $None   => dflt)
};
```

The full type-inference reference is at [/reference/hm-lite](/reference/hm-lite).
