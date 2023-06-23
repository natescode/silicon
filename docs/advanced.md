# ADVANCED

## Range / Series

`..` defines a range or series. Ranges are _definite_. Series are _infinite_.

a range / series of type T is define like so

    [T..]

    // Define infinite series of even integers
    @let evens:[int..] = 2..4..

    // treat it like a normal array
    evens[10] // 20

We can even calculate the Fibonacci series using the @x lambda variable.

    @let fib = 1,1,@x[-2] + @x[-1]..
    fib[10] // 55

## Interators

Like Ruby, `Silicon` has both internal and external iterators.

## Non-Local Return

Internal iterators are preferred but most languages don't have any way to express returning early from them. `Silicon` does!

### Keyword vs Monad

While `@return` exists, Silicon prefers implicit returns. We can use `@return_parent` for the non-local return.

The monadic way is to use a special `iterator optional` called a `PROCESS MAYBE`

    @enum proc_maybe
        $NONE
        $SOME T
        $DONE T
    @

So all we have to do is return is a `$Done final_value`

## Destructuring

Silicon has it AND it lets you mix declaration when doing it.

    @let first_name

    first_name, @let last_name = {first_name = "Nate", last_name = "Hedglin}
