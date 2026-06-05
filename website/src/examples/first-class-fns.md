---
title: First-class functions
---

# First-class functions

Functions are values:

```silicon
@fn add a:Int, b:Int := { a + b };
@fn sub a:Int, b:Int := { a - b };

@fn apply f:$fn _:Int _:Int _:Int, x:Int, y:Int := { &f x, y };

@fn main := {
    @global s:Int := &apply add, 3, 4;        # 7
    @global d:Int := &apply sub, 10, 4;       # 6
    s + d                                  # 13
};
```

`:$fn _:Int _:Int _:Int` is the parameter-type annotation — a function
taking `(Int, Int)` and returning `Int`.

Indirect calls compile to `call_indirect` over the function reference
table; the typechecker resolves the function signature at the call
site.

`Vec[T]::map` uses this:

```silicon
@fn double n:Int := { n * 2 };

@fn main := {
    @global v:Vec[Int] := &Vec::from_array [1, 2, 3, 4];
    @global doubled:Vec[Int] := &Vec::map &v, double;
    0
};
```

[Reference: function-type as a first-class SiliconType →](/reference/types)
