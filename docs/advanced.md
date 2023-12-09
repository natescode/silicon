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

Silicon has no `this` keyword. Silicon uses UFCS but has no real methods or dispatch. It has TDFD or whatever.

~~Silicon is structurally typed _by default_ like `Go`. Silicon is a flexible language with _modes_ and _defaults_.~~

### Trait aka Interface

Interfaces in Silicon are just like traits like `Rust`, they're nominally typed and can be applied to types after the fact.

`this` / `self` is just the first parameter.

```silicon
    @type iText:trait 'T = {
        @fn toUpperCase:string value:T
    }

    // takes a string pointer and returns void
    /// ->str => void
    @fn toUpperCase:void self:->str
        self.map(
            @fn _ index,val
                @if val in 65..90
                @then << 4
                @else val
            @
        )
    @
```

### Universal Function Call Syntax UFCS

```silicon
    // function syntax
    #toUpperCase("hello, world")

    // method syntax
    "hello, world".toUpperCase // "HELLO, WORLD"
```

### Traits

// TODO: likely just add an `@alias` keyword

## Modes aka Dialects

Silicon has modes. It can by dynamically typed, statically typed, interpreted and compiled. It can be memory managed with various GC implementations, it can be manuall memory managed or managed with `locality` like OCaml or `borrower checker` like R\*st.

## Custom Allocators & GC

Silicon allows developens to create their own custom allocator, like Zig, as well as custom GC implementations that work natively.

## Keywords

Silicon uses `@` prepended to all keywords for a very good reason. There will never be conflicts with new keywords added to the language.

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
    (array.head 0)
    (array.tail 0)
```

## Range / Series

`..` defines a range or series. A `range` is _definite_ while a `series` is _infinite_. Ranges have a final value to calculate to `0..100` is 0 to 100 (inclusive if possible). A step may be added via a middle value `0..2..100` will count by 2's. `0..3..100` will only go to 99. `0..2..` will count by 2's indefinitely. `[0..2..].get(50)` will return `100`.

a range / series of type T is define like so

    [T..]

    // Define infinite series of even integers
    @let evens:[int..] = 2..4..

    // treat it like a normal array
    evens.get(10) // 20
    evens(10) // 20
    (evens 10) // 20

## Interators

Like Ruby, `Silicon` has both internal and external iterators.

`@exit` return / break from current scope
`@yeet` return from parent scope (non-local return like Ruby and Smalltalk)
`@give` yield value

## Non-Local Return

Internal iterators are preferred but most languages don't have any way to express returning early from them. `Silicon` does! `@yeet`

## Destructuring

Silicon has it AND it lets you mix declaration when doing it.

    @let first_name

    first_name, @let last_name = $(first_name = "Nate", last_name = "Hedglin)


Silicon doesn't have a `new` keyword because that would be confusing. We aren't heap allocating.

## Pointer vs Reference

> _*This will require more thinking*_

Silicon just calls them interchangeably. How they behave depend how they are declared. In C++ pointers can be reassigned while reference cannot. In silicon `->` is just a pointer. `@ref` is by default a reference but `@mut @ref` is a mutable reference, maybe that could just be `@ptr` instead?

Reference automatically dereference themselves, which is convient for most development but I also like C's explicit `data->field` syntax.

## Locality, Modes, Oxidizing Silicon (Silica / Quartz)

My idea of `modes` comes from Jonathan Goodwin's paper, _"A Framework for Gradual Memory Management"_. This has become very popular, especially since Crablang aka R\*st has become so popular.

This won't be implemented until V2 but Silicon will start taking the `locality` approach that JaneStreet took with [Oxidizing OCaml](https://blog.janestreet.com/oxidizing-ocaml-locality/).

## Generics

Silicon will have true generics like `C#`.

### Syntax

Silicon's goal for syntax is to be similar to C but cleaner like Go i.e. no parens. One issue though is that `List<T>` syntax messed with LSPs because HTML uses `<>` as well. So I want a cleaner syntax. `List:T` or `List:(T)`

C#

```c#
    var map = new Dict<int,string>();
    var map = new Dict<Dict<int,bool>,string>();
```

Si

    @let ['T] genericAdd:T a:T,b:T = { a + b }


### Multi-line strings

Just use backticks like Javascript

    @let word = "interpolation"

    `multi-line string
    with ${word} support!`
