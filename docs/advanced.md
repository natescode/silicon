# ADVANCED

## Opaque and Pointer Types

### Opaque

The Opaque type is used for extern types like for interoping with C or environment provided APIs.

### Pointers

`->` _raw pointer_
`@ptr` _raw pointer alias_
`@fptr` _fat pointer_
`@vptr` _vtable pointer_
`@ref` _reference_
`@extern` _extern type_ uses `@opaque` underneath because the size is not known, nor is it dynamic.

## `this`, traits, interfaces

Silicon is structurally typed _by default_ like `Go`. Silicon is a flexible language with _modes_ and _defaults_.

### Interface

Interfaces in Silicon are just like interfaces like `Go`, they're structurally typed and can be applied to types after the fact. There is no empty `interface{}` though. Silicon has real Generics and `Quasi Quotes`.

`this` / `self` is just the first parameter.

'=>' makes sense for lambda functions BUT I like the idea of '->' for pointers and '=>' for references or fat pointers. But I'll likely just use `@fptr` and `@vptr` instead for fat pointer and vtable pointers, respectively.

    @type iText interface
        toUpperCase: void, ->str
    @
    // takes a string pointer and returns void
    /// ->str => void
    @fn toUpperCase:void self:->str
        #self.map index,val =>
            @if val in 65..90
            @then << 4
            @else val
    @

    // function syntax
    #toUpperCase "hello, world"

    // method syntax
    #"hello, world".toUpperCase // "HELLO, WORLD"

### Traits

Parameters and Types (including Interfaces) can be defined as _nominally typed_. The `$` Sigil shows this.

Pretend we have a `char` type that is an alias for `byte`

    @fn toUpperCase:$char

    @let fakeChar:int`8` = 65
    fakeChar.toUpperCase
    // error. 'fakeChar' doesn't have nominal type '$char'

Structural Interface

    @type Reader @interface

Nominal Interface

     // potential syntax
    @type Reader $@interface
    @type $Reader @interface
    @type Reader @trait

## Modes

Silicon has modes. It can by dynamically typed, statically typed, interpreted and compiled. It can be memory managed with various GC implementations, it can be manuall memory managed or managed with `locality` like OCaml or `borrower checker` like R\*st.

## Custom Allocators & GC

Silicon allows developens to create their own custom allocator, like Zig, as well as custom GC implementations that work natively.

## Custom Keywords

Silicon uses `@` prepended to all keywords for a very good reason. There will never be conflicts with new keywords added to the language. This also allows custom domain specific operator and keywords.

TODO: finish example

    @@define_keyword `foreach` iterator, $capture
        @for
    @@

## Quasi-Quotes

## Macros

## UFCS

[Uniform Function Call Syntax](https://en.wikipedia.org/wiki/Uniform_Function_Call_Syntax) treats function as methods based on the first parameter type. `nim`, `rust` and `zig` do this as well. Silicon does not have a 'this' keyword, nor closures. At least for the time being. It adds too much complexity.

    @fn plusOne:int n:int
        n + 1
    @

    $age = 32
    #plusOne age // 33
    age.plusOne // 33

## Negative Indexing

Silicon allows negative indexing into all iterables. There are also `head` and `tail` methods to get the index item starting from the beginning or the end.

```typescript
    // function syntax
    #head array 0
    #tail array 0

    // method syntax
    array.head 0
    array.tail 0
```

## Range / Series

`..` defines a range or series. A `range` is _definite_ while a `series` is _infinite_. Ranges have a final value to calculate to `0..100` is 0 to 100 (inclusive if possible). A step may be added via a middle value `0..2..100` will count by 2's. `0..3..100` will only go to 99. `0..2..` will count by 2's indefinitely. `[0..2..][50]` will return `100`.

a range / series of type T is define like so

    [T..]

    // Define infinite series of even integers
    @let evens:[int..] = 2..4..

    // treat it like a normal array
    evens[10] // 20

### Series Comprehension

Much like Python's list comprehensions.

We can calculate the Fibonacci series using the implicit @x lambda variable which is the current array.

`@x[-1]` is negative indexing into the current array of the series and getting the last item, so far. Silicon will only hold as much data that is needed to calculate the next value, 2 in this case. If you want ALL of the data to be eagerly loaded, use a range or slice of a series.

    @let fib = 1,1,@x[-1] + @x[-2]..
    fib[10] // 55
    fib[0:9] // slice of series
    // all in one line passing in the type and size
    @let fib:[int..10] = 1,1,@x[-1] + @x[-2]..

## Interators

Like Ruby, `Silicon` has both internal and external iterators.

## Non-Local Return

Internal iterators are preferred but most languages don't have any way to express returning early from them. `Silicon` does!

### Keyword vs Monad

While `@return` exists, Silicon prefers implicit returns. We can use `@return_parent` for the non-local return.

The monadic way is to use a special `iterator optional` called a `PROCESS MAYBE`

    @enum proc_maybe 'T
        $NONE
        $SOME T
        $DONE T
    @

So all we have to do is return is a `$Done final_value`

## Destructuring

Silicon has it AND it lets you mix declaration when doing it.

    @let first_name

    first_name, @let last_name = {first_name = "Nate", last_name = "Hedglin}

## Class vs Struct

Silicon is fairly low-level because its target, WASM, currently doesn't have a GC or other features. Silicon does not ever do heap allocation unless the developer explicitly asks. This is true for classes which are closer to C++ classes.

Silicon structs are just like `Go` structs. The one thing I didn't like about `Go`'s structs is the `new` syntax convention. If a convention is needed, the language is missing a feature. So `class` was born.

_\*Silicon is NOT OOP. There is no inheritance. If inheritance were to every be added, it would require classes that are inherited to be abstract._

| Feature        | Struct | Class |
| -------------- | ------ | ----- |
| aligned        | ✅     | ✅    |
| pointer fields | ❌     | ✅    |
| constructor    | ❌     | ✅    |

### Struct

Structs are simple, continous data that aligned in memory. The data uses the defaults of the given field's type. There are no pointer, a struct is always **ALL** the data you need.

    @type Person @struct
        name:str
        age:int
    @

    @let nate = Person{name="Nate",age=32}

### Class

Classes are more complex. They're desiged to create reference types, something `Go` uses internally but doesn't give to the developer. Class fields may be pointer (think a head node of a tree). Pointers cannot be null and more complex data-structures may need a constructor function because they cannot rely solely on 'reasonable defaults'.

Silicon's syntax is meant to be as familiar as possible for C devs **BUT** there are careful consideration taken for parsing. Using `*` for pointers can make syntax ambigous. So Silicon uses the less convient `->` **OR** `@ref` keyword (`@ref` is subtally different in that it wraps the type with an Optional). `->` can not but `null`. `@ref` can be `NONE`.

    @class Person
        name:str
        age:int
        bff:@ref Person
    @

Silicon doesn't have a `new` keyword because that would be confusing. We aren't heap allocating. Instead we should call the class name as if it is a constructor function (which it is in C languages. Javascript does this but with `new`).

_\*I'm not 100% sure on the syntax yet_

Multiline function / constructor call

    @let nate = #Person name="nate",
                        age=32,bff={},
                        siblings={},
                #

Singleline function / constructor call

    @let nate = #Person name="nate",age=32,bff={},siblings={}

Not using `#` block. `,` is the continuation character, otherwise newline is our terminal character.

    @let nate = #Person name="nate",
                        age=32,bff={},
                        siblings={}

## Pointer vs Reference

> _*This will require more thinking*_

Silicon just calls them interchangeably. How they behave depend how they are declared. In C++ pointers can be reassigned while reference cannot. In silicon `->` is just a pointer. `@ref` is by default a reference but `@mut @ref` is a mutable reference, maybe that could just be `@ptr` instead?

Reference automatically dereference themselves, which is convient for most development but I also like C's explicit `data->field` syntax.

## Locality, Modes, Oxidizing Silicon (Silica / Quartz)

My idea of `modes` comes from Jonathan Goodwin's paper, _"A Framework for Gradual Memory Management"_. This has become very popular, especially since Crablang aka R\*st has become so popular.

This won't be implemented until V2 but Silicon will start taking the `locality` approach that JaneStreet took with [Oxidizing OCaml](https://blog.janestreet.com/oxidizing-ocaml-locality/).
