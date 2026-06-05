---
title: Error handling with @try
---

# Error handling with `@try`

`Result[T, E]` is the canonical fallible-return type:

```silicon
@type Result[T, E] := $Ok value T | $Err error E;

\\ parse_int (Str) -> Result[Int, Str]
@fn parse_int s := …;

\\ add_two_parsed (Str, Str) -> Result[Int, Str]
@fn add_two_parsed a, b := {
    @global x := &@try (&parse_int a);   # propagates $Err
    @global y := &@try (&parse_int b);
    &Ok (x + y)
};
```

`&@try expr` evaluates `expr`. On `$Ok v` the expression's value is `v`.
On `$Err e` the enclosing function returns `$Err e` immediately.

`@try` is a *prefix-keyword* — Silicon bans postfix operators (see
[ADR 0010](/stability/adrs)), so there's no Rust-style `expr?`.

For default-on-error, prefer `&unwrap_or`:

```silicon
\\ safe_lookup (HashMap, Int) -> Int
@fn safe_lookup map, key := {
    &unwrap_or (&HashMap::get &map, key), 0
};
```
