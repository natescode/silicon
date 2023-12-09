## No Unary Operators

> "What?! What about ...?"

Silicon only has binary infix operators. This is a hard requirement that will never change in the Silicon language specification.

Typical unary operators

    -x
    -1
    ++x
    x++
    !x
    &x
    *x

None are needed.

| unary operator | alternative 1 | alternative 2     |
| -------------- | ------------- | ----------------- |
| -x             | x.neg         | 0 - x             |
| -1             | 1.neg         | 0 - 1             |
| ++x            | x += 1        | x.inc             |
| x++            | x.post_inc    | @defer x += 1; x; |
| !x             | @not x        | x.not             |
| &x             | @val x        | x.val             |
| \*x            | @ref x        | x.ref             |

Instead of `&x++` we can do `x.val.pinc`

Silicon prefers methods over operators.

So no fancy Pratt parsing or Pika Parsing needed to handle prefix or postfix operators, they DON'T exist!

_\*sigils aren't operators_