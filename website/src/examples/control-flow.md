---
title: Conditions & loops
---

# Conditions & loops

## `@if`

`@if` is both a statement and an expression: `@if(cond, { then }, { else })`.

```silicon
@if(x == 0, { print('zero') }, { print('nonzero') });
```

As an expression it yields a value (both branches must agree on type):

```silicon
@mut label := @if(score >= 60, { 'pass' }, { 'fail' });
```

There is no `&&` operator — write logical AND as a nested `@if`. `||` is
available for OR.

## `@loop`

Silicon has **one** loop keyword. Its meaning is chosen by how many operands
appear before the trailing `{ body }` block — no `for`, no `foreach`:

| Form | Meaning |
| --- | --- |
| `@loop({ body })` | infinite — loop forever, exit with `@break()` |
| `@loop(cond, { body })` | while — `cond` is re-checked each iteration |
| `@loop(v, subject, { body })` | iterate — `v` ← each element |
| `@loop(i, v, subject, { body })` | iterate — `i` ← position, `v` ← element |

`@break()` exits early; `@continue()` skips to the next iteration.

### while

```silicon
@mut i := 0;
@loop(i < 10, {
    print_int(i);
    i = i + 1;
});
```

### Ranges — `lo..hi` (half-open, `hi` excluded)

```silicon
@mut total := 0;
@loop(v, 0..5, { total = total + v });   # v = 0,1,2,3,4  → total 10

# Two binders: position then element (they diverge once lo ≠ 0).
@loop(i, v, 2..5, { … });                # i = 0,1,2 ; v = 2,3,4
```

A range is empty when `lo >= hi` (so `3..3` and `5..3` run the body zero
times). `..` is valid only as a `@loop` subject — it is not a stored value.

### Iterating a `Vec`

```silicon
xs := vec_new(4);
vec_push_i32(xs, 10);
vec_push_i32(xs, 20);

@mut sum := 0;
@loop(x, xs, { sum = sum + x });         # element binder
@loop(i, x, xs, { … });                  # index + element
```

Use the `_` discard binder to iterate without naming the element:
`@loop(_, 0..n, { … })`.

::: tip v1 scope
The range and `Vec` forms above ship and dispatch today (element values are
i32 — `Int`, `Bool`, or a pointer). The general `next -> IterStep[T,R]`
iterator protocol (`@use 'iter';`) ships as a documented convention you drive
by hand; `@loop` does not yet auto-select it for arbitrary types. See
[ADR 0016](https://github.com/) for the full design and what each later form
waits on.
:::

## `@return`

Return early from a function with `@return`:

```silicon
\\ safe_div (Int, Int) -> Int
@fn safe_div x, y := {
    @if(y == 0, { @return(0) }, {});
    x / y
};
```

## FizzBuzz — putting it together

```silicon
\\ fizzbuzz (Int) -> Int
@fn fizzbuzz n := {
    @mut i := 1;
    @loop(i <= n, {
        by3 := (i % 3) == 0;
        by5 := (i % 5) == 0;
        @if(by3, {
            @if(by5, { print('FizzBuzz') }, { print('Fizz') });
        }, {
            @if(by5, { print('Buzz') }, { print_int(i) });
        });
        i = i + 1;
    });
    0
};

@fn main := { fizzbuzz(15) };
main();
```

```sh
sgl run    # → 1 2 Fizz 4 Buzz Fizz 7 8 Fizz Buzz 11 Fizz 13 14 FizzBuzz
```

Pattern matching on sum types uses `@match` — see
[Sum types + `@match`](/examples/sum-types).
