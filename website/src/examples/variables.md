---
title: Variables
---

# Variables

Silicon has two value bindings, distinguished by **mutability**:

```silicon
@global PI := 3.14159;   # immutable — a module constant
@local count := 0;       # mutable
count = count + 1;       # reassign — only @local can be reassigned
```

- `@global` is an **immutable** top-level binding (a module constant).
  Reassigning it is a compile error (`E0007`).
- `@local` is **mutable**. At the top level it's a module variable; inside a
  function it's a local. Reassign with `name = expr`.

Types are always **inferred** — a binding never carries a type annotation. To
pin types, annotate the *function* with a `\\` signature line (see
[Functions](/examples/functions)).

```silicon
@use 'io';

@global LIMIT := 5;

@fn main := {
    @local sum := 0;
    @local i := 1;
    &@loop i <= LIMIT, {
        sum = sum + i;   # @local is mutable
        i = i + 1;
    };
    &print_int sum;      # 15
    0
};
&main;
```

```sh
sgl run    # → 15
```

## Immutable means immutable

```silicon
@global MAX := 100;
@fn bad := { MAX = 200; MAX };   # error: 'MAX' is immutable and cannot be reassigned
```

Reach for `@global` for constants and configuration that never change, and
`@local` for everything you compute or update.
