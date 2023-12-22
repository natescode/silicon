## FUNCTIONS

Parenthesis and types are optional.

## Parenthesis

Silicon grammar doesn't use parethesis for anything but grouping expression.

## Types

ALL types in Silicon are inferred. They can be optionally included after the identifier with `:type` syntax.

## Implicit returns

Silicon has implicit returns. `Rust` is a modern example of this. You can still use the `@exit` keyword for explicit returns.

### Ambiguous function calls

We might see something like this in a C-like language

    ```c
    fib(n - 1) + fib(n - 2)
    ```

Silicon uses parenthesis like LISP because the above could mean

`fib(n-1 + fib(n-2))` or `fib(n) - 1 + fib(n) - 2` etc...

Silicon can disambiguate with `()`

```lisp
(fib n - 1) + (fib n - 2)
```

Generally, this doesn't happen and removing parens in much easier to read. The Si LSP will warn about ambigous expressions like this.
