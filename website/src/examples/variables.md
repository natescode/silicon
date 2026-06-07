---
title: Variables
---

# Variables

Silicon has two value bindings, distinguished by **mutability**:

```silicon
PI := 3.14159;           # immutable — a module constant
@mut count := 0;         # mutable
count = count + 1;       # reassign — only @mut can be reassigned
```

- A bare `name := value` is an **immutable** binding (a module constant at the
  top level, an immutable local inside a function). Reassigning it is a compile
  error (`E0007`).
- `@mut` is **mutable**. At the top level it's a module variable; inside a
  function it's a mutable local. Reassign with `name = expr`.

Types are always **inferred** — a binding never carries a type annotation. To
pin types, annotate the *function* with a `\\` signature line (see
[Functions](/examples/functions)).

```silicon
@use 'io';

LIMIT := 5;

@fn main := {
    @mut sum := 0;
    @mut i := 1;
    @loop(i <= LIMIT, {
        sum = sum + i;   # @mut is mutable
        i = i + 1;
    });
    print_int(sum);      # 15
    0
};
main();
```

```sh
sgl run    # → 15
```

## Immutable means immutable

```silicon
MAX := 100;
@fn bad := { MAX = 200; MAX };   # error: 'MAX' is immutable and cannot be reassigned
```

Reach for bare bindings for constants and configuration that never change, and
`@mut` for everything you compute or update.
