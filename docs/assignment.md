### Declaration

There is only one declaration syntax, `@name`.

    @name firstName
    @name firstName:string

Silicon has 100% type inference, the developer **NEVER** needs to write types. Types may be optionally added after identifiers with `:type` syntax for clarity, or `sgl --annotate file.si` can add them for you.

### Assignment

`=` is for assignment.

Silicon by default is immutable and pure. This means reference have referencial transparency.

    @name x = 3;
    x = 5; // error: assignment to immutable variable 'x'

Referencial Tranparency

    x = #first #rand 1..10;
    x + x == (#first #rand 1..10) + (#first #rand 1..10);

Even `random` isn't random. It returns an iterator that generates a series of pseudorandom numbers. Now the output of `#rand 1..10` is unique for each time we run our program because when we build the project a new seed is generated.

### Deconstructing Assignment

Silicon like other languages have Deconstructing assignment.

We can also mix and match new declarations, something `Go`'s `:=` gopher syntax can't do.

```silicon
    @name a:mut(int)

    // a is assigned
    // b is declared AND assigned
    a, @name b = ("into a", "into b")
```

## Defs

All definitions: `@name`, `@func`, ``@type`, and `@comp` use assignment syntax `=`. This make Silicon's grammar much more intuitive and consistent.

They all follow the exact same grammar `'@' keyword TypedIdentifier params? '=' expression`

### `@name`

    @name nate = (first="Nathan",last="Hedglin",age=30)

### `@func`

    @func add a,b = { a + b }

### `@type`

    @type point = (x:int = 0, y:int = 0)

### `@comp`

    @comp math = {
        @fn add a,b = {a + b},
        @fn sub a,b = {a - b},
        @fn mult a,b = {a * b},
        @fn div a,b = {a / b},
    }

    #math.add 1,2 // 3

## Conclusion

Pretty much everything else in Silicon that isn't a _DEFINITION_ is an _EVALUATION_ aka function.
