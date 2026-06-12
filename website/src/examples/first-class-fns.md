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

## Closures: capturing state

A plain function reference has no environment. A **closure** captures
surrounding values by value: `@closure(body_fn, …caps)` binds the
leading parameters of `body_fn` to the captures, and `@call_closure`
invokes it with the remaining arguments.

```silicon
\\ scale (Int, Int) -> Int
@fn scale factor, x := { factor * x };          # leading param `factor` is the capture
\\ run (Int, Int) -> Int
@fn run factor, x := {
    scaler := @closure(scale, factor);          # capture `factor`
    @call_closure(scaler, x)                      # = scale(factor, x)
};

@fn main := { run(3, 5) };                        # 15
```

Two closures over the same body keep independent environments, and a
closure can be passed to a higher-order function (the `map`/`filter`/`fold`
combinator case).

## Host callbacks

To hand a closure to the **host** as a callback it stores and calls back
later, wrap it in `@export_callback` at the `@extern` boundary:

```silicon
\\ @extern on_click (Vec[Int]) -> Void;          # host stores the callback
\\ scale (Int, Int) -> Int
@fn scale factor, x := { factor * x };
\\ register (Int) -> Void
@fn register factor := { on_click(@export_callback(@closure(scale, factor))) };
```

The host invokes it later via a generated `__closure_invoke_<k>`
trampoline, with the captured environment intact. Under
`--target=wasm-gc` the closure environment is engine-garbage-collected.

[Reference: function-type as a first-class SiliconType →](/reference/types)
