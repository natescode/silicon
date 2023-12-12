## FUNCTIONS

Again parenthesis aren't needed.

Add function

    /// num,num -> num
    @let add a,b = {
        a + b
    }

With types

    @let add:num a:num, b:num = {
        a + b
    }

    #add 10,20 // 30

_\*I'm still debating on function call syntax if `()` are needed and if `#` sigil should be used_. I know sometimes function calls could be ambigous without parens BUT which bothers me but 90% of the time that is cleaner. PLUS to disambiguate, parens are simply used to group so there aren't any special semantics.

### Ambiguous function calls

We might see something like this in a C-like language

    fib(n - 1) + fib(n - 2)

Silicon uses parenthesis like LISP because the above could mean

`fib(n-1 + fib(n-2))` or `fib(n) - 1 + fib(n) - 2` etc...

Silicon can disambiguate with `()`

```lisp
(fib n - 1) + (fib n - 2)
```

Generally, this doesn't happen and removing parens in much easier to read.
