---
title: First-class functions
---

# First-class functions

Functions are values:

```silicon
\\ add (Int, Int) -> Int
@fn add a, b := { a + b };
\\ sub (Int, Int) -> Int
@fn sub a, b := { a - b };

\\ apply ($fn (Int, Int) -> Int, Int, Int) -> Int
@fn apply f, x, y := { &f x, y };

@fn main := {
    @global s := &apply add, 3, 4;        # 7
    @global d := &apply sub, 10, 4;       # 6
    s + d                                  # 13
};
```

`$fn (Int, Int) -> Int` is the parameter-type annotation — a function
taking `(Int, Int)` and returning `Int`.

Indirect calls compile to `call_indirect` over the function reference
table; the typechecker resolves the function signature at the call
site.

`Vec[T]::map` uses this:

```silicon
\\ double (Int) -> Int
@fn double n := { n * 2 };

@fn main := {
    @global v := &Vec::from_array [1, 2, 3, 4];
    @global doubled := &Vec::map &v, double;
    0
};
```

[Reference: function-type as a first-class SiliconType →](/reference/types)
