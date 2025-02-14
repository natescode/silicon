### Declaration

There is only one declaration syntax, `@var` or `@name`.

    @name first_name;
    @name first_name:string;


*Aside*
> Silicon uses snake case. Once thing the Python language got correct. 

*if Python uses snake case. Does OCaml use Camel case and Pascal use Pascal case?*


Silicon has powerful type inference, the developer **rarely** needs to write types. Types may be optionally added after identifiers with `:type` syntax for clarity, or `sgl --annotate file.si` can add them for you.

\* Technically the developer, sometimes, will _want_ to add types. Having a language with 100% type inference is cool but very limiting. Sigil *MAY* warn about types that get inferred as `@any` where the compiler cannot figure out a more specific type. More research and practice will be needed with this.

### Assignment

`=` is for assignment.

Silicon by default is immutable and pure. This means references have referencial transparency. I don't want Silicon to be TOO ML, otherwise I might as well use Haskell. I think at least separating pure and impure code is a good idea. Maybe that can be done with `=` as well, I'm not sure.

    @let x = 3;
    x = 5; # error: assignment to immutable variable 'x'

Referencial Tranparency

    x = &first &rand 1..10; # 3
    ## @@pure macro that takes an optional number (the nth time a function should be called), and function
    x + x == (@@pure _, &rand 1..10) + (@@pure _, &rand 1..10); # 3 + 3 === 1 + 7

Other Ideas?

    x = `&rand 1..10` # backtic quotes the code aka the code will be interpreted at runtime
    x + x === `&rand 1..10` + `#rand 1..10` # FALSE, but they both run the code twice

Even `random` isn't random. It returns an iterator that generates a series of pseudorandom numbers. Now the output of `#rand 1..10` is unique for each time we run our program because when we build the project a new seed is generated.

### Deconstructing Assignment

Silicon like other languages have Deconstructing assignment.

~~We can also mix and match new declarations, something `Go`'s `:=` gopher syntax can't do.~~

```silicon
    @name a:mut(int)

    // a is assigned
    // b is declared AND assigned
    a, @name b = ("into a", "into b")
    # new variables with $ sigil was an old idea.
    # tuples would probably be just `[]` or `$()`
    a, $b = ["into a", "into b"] 
```

Thinking more like this now

```silicon

    @name a:(mut int);
    a, $b = ["into A", "into b"];
```

## Defs

All definitions: `@name`, `@func`, ``@type`, and `@comp` use assignment syntax `=`. This make Silicon's grammar much more intuitive and consistent.

They all follow the exact same grammar `keyword name type? params? '=' expression`

### `@name`

    @name nate = (first="Nathan",last="Hedglin",age=30);

### `@func`

    @func add a,b = { a + b; };

### `@type`

    @type point = (x:int = 0, y:int = 0);

### `@comp`

    @comp math = {
        @fn add a,b = {a + b},
        @fn sub a,b = {a - b},
        @fn mult a,b = {a * b},
        @fn div a,b = {a / b},
    };

    #math.add 1,2; # 3

## Conclusion

Pretty much everything else in Silicon that isn't a _DEFINITION_ is an _EVALUATION_ aka function.
