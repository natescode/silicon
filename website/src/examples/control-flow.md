---
title: Conditions & loops
---

# Conditions & loops

## `@if`

`@if` is both a statement and an expression: `&@if cond, { then }, { else }`.

```silicon
&@if x == 0, { &print 'zero' }, { &print 'nonzero' };
```

As an expression it yields a value (both branches must agree on type):

```silicon
@local label := &@if score >= 60, { 'pass' }, { 'fail' };
```

There is no `&&` operator — write logical AND as a nested `@if`. `||` is
available for OR.

## `@loop`

`@loop` repeats while a condition holds; `&@break` exits early:

```silicon
@local i := 0;
&@loop i < 10, {
    &print_int i;
    i = i + 1;
};
```

## `@return`

Return early from a function with `&@return`:

```silicon
\\ safe_div (Int, Int) -> Int
@fn safe_div x, y := {
    &@if y == 0, { &@return 0 }, {};
    x / y
};
```

## FizzBuzz — putting it together

```silicon
@use 'io';

\\ fizzbuzz (Int) -> Int
@fn fizzbuzz n := {
    @local i := 1;
    &@loop i <= n, {
        @local by3 := (i % 3) == 0;
        @local by5 := (i % 5) == 0;
        &@if by3, {
            &@if by5, { &print 'FizzBuzz' }, { &print 'Fizz' };
        }, {
            &@if by5, { &print 'Buzz' }, { &print_int i };
        };
        i = i + 1;
    };
    0
};

@fn main := { &fizzbuzz 15 };
&main;
```

```sh
sgl run    # → 1 2 Fizz 4 Buzz Fizz 7 8 Fizz Buzz 11 Fizz 13 14 FizzBuzz
```

Pattern matching on sum types uses `@match` — see
[Sum types + `@match`](/examples/sum-types).
