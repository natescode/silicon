---
title: Functions
---

# Functions

Define a function with `@fn`. A `\\` **signature line** directly above it
declares the parameter and result types:

```silicon
\\ add (Int, Int) -> Int
@fn add a, b := { a + b };
```

Call a function with a leading `&`; arguments are comma-separated:

```silicon
@local s := &add 2, 3;   # 5
```

A single-expression body needs no braces:

```silicon
\\ square (Int) -> Int
@fn square n := n * n;
```

The signature line is also how you type parameters — Silicon has **no inline
`:Type` annotations**. Without a signature, parameters are unbound:

```silicon
\\ greet (String) -> Int     # required: declares `name : String`
@fn greet name := { &print ('Hello, ' ++ name ++ '!') };
```

## A complete program

```silicon
@use 'io';

\\ factorial (Int) -> Int
@fn factorial n := {
    &@if n <= 1, { &@return 1 }, {};
    n * (&factorial (n - 1))
};

@fn main := {
    &print_int (&factorial 5);   # 120
    0
};
&main;
```

```sh
sgl run    # → 120
```

## Exporting and importing

Export a function to the host with `@export`, and import a host function with
`@extern`:

```silicon
@export factorial;

@extern { \\ puts (String) -> Int }
&puts 'from libc';
```

Functions are first-class — see [First-class functions](/examples/first-class-fns)
for `@fnref` and indirect calls.
