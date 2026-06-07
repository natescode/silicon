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

\\ apply ((Int, Int) -> Int, Int, Int) -> Int
@fn apply f, x, y := { f(x, y) };

@fn main := {
    s := apply(add, 3, 4);        # 7
    d := apply(sub, 10, 4);       # 6
    s + d                          # 13
};
```

`(Int, Int) -> Int` is the parameter-type annotation — a function
taking `(Int, Int)` and returning `Int`.

Indirect calls compile to `call_indirect` over the function reference
table; the typechecker resolves the function signature at the call
site.

`Vec[T]::map` uses this:

```silicon
\\ double (Int) -> Int
@fn double n := { n * 2 };

@fn main := {
    v := Vec::from_array($[1, 2, 3, 4]);
    doubled := Vec::map(v, double);
    0
};
```

[Reference: function-type as a first-class SiliconType →](/reference/types)
