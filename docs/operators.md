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

### No operator precedence ?!

> "Ok. Now you've lost me. Go is simple. Zig is simple. But THIS?!, This is too far. This isn't simplicity it's absurdity!!! " -- imaginary reader

Silicon isn't the first, just the minority (smalltalk, LISP, and APL) to not implement operator precedence. This choice is not out of laziness or incompetence but practicality. There are 3 main issues with operator precedence:

1. `C` infamously gets [operator precedence wrong](). Which means languages aren't consistent on this.

1. `humans` infamously get [operator precedence wrong]().

1. `math notation` is only approximated in general purpose programming languages. We aren't embedding LaTeX into Silicon, that would add even more complexity to both the human and computers parsing task. Even something as simple as the formula to get the average of two numbers

```
a + b
------
  2
```

is expressed wrongly as `a + b / 2` which means `a + (b/2)` not `(a+b)/2`

The proper formula for computer science is `b - a / 2 + a` to avoid integer overflows. `b.(minus a).(over 2).(plus a)`

So Silicon just removes it. The order is left to right, simple. If a coder wants an expression evalutated in a different order than left to right then add parens. In fact, to avoid confusion when copying formulas like `2 + 3 * 4` the Silicon LSP will automatically add parethesis in the appropriate places i.e. `2 + (3 * 4)`. That is another part of the Silicon ethos, _"don't add to the language what you can add to the LSP"_.

> _"Don't add to the language (parser) what you can add to the LSP"_

One of Silicon's priorities is simplicity, clarity and precision. Silicon avoids ambiguity at all costs. Usually expressed with the phrase "Be simple and get the simple things right". Unlike Robotics where simple things for humans are often difficult for robots and vice versa, if parsing is difficult for a human then it is usually difficult for the parser as well. Operator precedence is a solved problem and there are several novel and simple algorithms to handle it of course but it DOES add complexity to the parser and take time. Simplicity natually lends to speed and scalability.

> _"Be simple. Get the simple things right"_

# ~Precedence~

| Precedence | Operator                                        | Description                                      |
| ---------- | ----------------------------------------------- | ------------------------------------------------ |
| 1          | =                                               | Assignment                                       |
| 2          | @or                                             | Boolean Or                                       |
| 3          | @And                                            | Boolean And                                      |
| 4          | @is, @not, @below, @most, @above, @least, @deep | Comparisons                                      |
| 5          | + - @bor @bxor                                  | Addition, Substraction, Bitwise Or, Bitwaise XOr |
| 6          | \* / @band                                      | Multiplication, Division, Bitwise And            |

## Operator Precedence

Pratt parsers and Pika parsers are really cool because they help with problem like operator precedence and left recursion, respectively.

I realize that by removing unary operator from Silicon than simplifies the language a lot.

> "...but you still need to handle operator precedence -- imaginary reader"

Hmm, true. Welp I guess we'll just remove operator precedenc all together from the language then.

you:

```
⢀⣠⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠀⠀⠀⠀⣠⣤⣶⣶
⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠀⠀⠀⢰⣿⣿⣿⣿
⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣧⣀⣀⣾⣿⣿⣿⣿
⣿⣿⣿⣿⣿⡏⠉⠛⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⣿
⣿⣿⣿⣿⣿⣿⠀⠀⠀⠈⠛⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠿⠛⠉⠁⠀⣿
⣿⣿⣿⣿⣿⣿⣧⡀⠀⠀⠀⠀⠙⠿⠿⠿⠻⠿⠿⠟⠿⠛⠉⠀⠀⠀⠀⠀⣸⣿
⣿⣿⣿⣿⣿⣿⣿⣷⣄⠀⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣴⣿⣿
⣿⣿⣿⣿⣿⣿⣿⣿⣿⠏⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠠⣴⣿⣿⣿⣿
⣿⣿⣿⣿⣿⣿⣿⣿⡟⠀⠀⢰⣹⡆⠀⠀⠀⠀⠀⠀⣭⣷⠀⠀⠀⠸⣿⣿⣿⣿
⣿⣿⣿⣿⣿⣿⣿⣿⠃⠀⠀⠈⠉⠀⠀⠤⠄⠀⠀⠀⠉⠁⠀⠀⠀⠀⢿⣿⣿⣿
⣿⣿⣿⣿⣿⣿⣿⣿⢾⣿⣷⠀⠀⠀⠀⡠⠤⢄⠀⠀⠀⠠⣿⣿⣷⠀⢸⣿⣿⣿
⣿⣿⣿⣿⣿⣿⣿⣿⡀⠉⠀⠀⠀⠀⠀⢄⠀⢀⠀⠀⠀⠀⠉⠉⠁⠀⠀⣿⣿⣿
⣿⣿⣿⣿⣿⣿⣿⣿⣧⠀⠀⠀⠀⠀⠀⠀⠈⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢹⣿⣿
⣿⣿⣿⣿⣿⣿⣿⣿⣿⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⣿⣿
```

Is may seem absolutely nuts, but is it?

`2 + 3 * 4` gets evaluated like `3 * 4 + 2` or `2 + (3*4)`. So I could either require parens, auto-insert them with the LSP or compiler, or just use methods.

`2.plus(3).times(4)` doesn't have the correct precedence.

I could also have the LSP fix this for you:

The LSP would take this `2 + 3 * 4` and add the appropriate parenthesis to make `2 + (3 * 4)` or `3.times(4).plus(2)` if you chose to refactor to method syntax.

Take the quadratic formula `-b±√(b²-4ac))/(2a)` isn't even written like math anyways. We'd have to use a sqrt function.

```
negative(b)
.plusorminus
.sqrtof(
    b.squared.minus.4.times(a,c)
    .over(2.times(a)
```

reads VERY close to how we speak the formula. This make it easier to write in my opinion. We're not doing LaTeX here.

or the formula for area of a circle = `π r²` becomes `pi * (r**2)` with the LSP or `pi.times(r.squared)`. Not of course `pi.times(r).squared`. Precedence is much clearer this way.
