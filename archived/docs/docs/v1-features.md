# v1.0 Features

1. WASM compilation target
1. Custom allocators `zig`
1. Comptime `zig`
1. Quote / Unquote macros for Hygenic Procedural Macros `lisp`
1. Sum types `ML`
1. Pattern Matching `ML`
1. Co-routines `Lua`
1. Yield Semantics
1. NO GC / Runtime \*GC Optional
1. 100% Type Inference `ML`
1. Errors as Value
1. WASI(X), POSIX, and Web API support
1. Immutable, Total / Pure, and Stack allocated by default


## WASM

Why WASM ? Because it is fast, secure, and universal. AND I'm lazy. It is as simple bytecode to target that has TONS of
other tools for package management, optimization and native compilation and JIT.

## Allocators

Like `Zig` being able to define custom allocators is pretty useful. Silicon believes in

> Reasonable Defaults

but custom allocators can be used.

Creating a new dictionary data-structure with string keys and int values (types) and a WASM allocator.

```silicon
    std::dict::new str,int, wasm_alloc
```

## Comptime

Comptime is a great way to do compile time abstractions and macros. Silicon also has more
LISP like macros that have the FULL language available.

`@comp` is the keyword for comptime. OR just use `#`

```silicon
@let x = @comp 1 + 5

@let x = #( 1 + 5 )
```

## Quote

This is LISP style macros for modifying the language itself. This is how Silicon does progressive bootstrapping of new features.

This is a HUGE win for compiler devs because we don't have to maintain two code bases or use some other weird bootstrapping workaround like Zig.

This is WHY Silicon is already bootstrapped so early.

Literally uses single quotes `''`

```
myFunction 'x + 1'
```

## Sum Types

```Ocaml
@type bool
    true
    false
@
```

## Pattern Matching

```ocaml
@match x
    true |> "You are authorized"
    false |> "Authorization Denied"
@
```

### Fizzbuzz in `Silicon`

Match can is like switch on steroids. It can be nestend and handle multiple parameters. Match
is an expression, it produces a value. We can fallthrough and accumulate values as we go with `@acc`.
So for _fizzbuzz_ if `x` is divisible by `5` we still check the next case because if both are true we accumulate (concat)
the values.

Match also has to be exhaustive, meaning ALL possible options must be accounted for.

with `@fn` instead of `@let` and lamda function

```silicon
@fn fizzbuzz x
    @match x % 5, x % 3
        _, 0 |> "fizz" @acc
        // if both 3 and 5 then we'll have accumulated "fizz" ++ "buzz"
        0,_  |> "buzz"
        // for ALL other values, just send `x`
        _, _ |> x
    @
@
```

Regular Fizzbuzz

```silicon
// if x is evently divisible by 5 then it'll be 0. `_` is wildcard for any other value.
@let fizzbuzz x => @match x % 5, x % 3
    _, 0 |> "fizz" @acc
    // if both 3 and 5 then we'll have accumulated "fizz" ++ "buzz"
    0,_  |> "buzz"
    // for ALL other values, just send `x`
    _, _ |> x
@

// series from 1 to 20
// pipe to fizzbuzz
// pipe that to print
1..20 -> fizzbuzz -> print
```

I'm not sure about `|>` or `->` for pipe

## Coroutines

```silicon
co::new @fn add a,b => a + b
```

## Implicit Returns

Implicit returns doesn't mean implicit values.

```silicon
@fn aNumber n
    @if n
    @then 10
    @else
@

// Error: function 'aNumber' branch '@else' doesn't return a value
```

If a function is just one expression then the `Silicon` standard is to use `@let` and lambda.

```silicon
    @let aNumber n =>
        @if n
        @then 10
        @else MAYBE::NONE
```

This would error out because `@else` doesn't return a value.

```silicon
// bool -> int?
@fn aNumber n
    @if n
    @then 10
    @else MAYBE::NONE
@
```

This returns `None` which would make the return type `Maybe(int)`

## Yield Semantics

Silicon tries to make concurrency safe and as easy as possible. Calling a function as a coroutine should be as similar as calling it as a normal function.

`GO` requires the two things

1. The function to be coded to use a Channel and Yield values
2. The function to accept a channel parameter

This makes `Go` functions actually limited in this sense when they become `goroutines`. Still MUCH better than `async` and `await`.

### returns array of number from x to y

```silicon
/// int,int -> ints
@fn x_to_y x,y
    @map x..y, $i
        i
    @
@
```

With lambda syntax

```silicon
/// int,int -> ints
@let x_to_y x,y => @map x..y, $i, i
```

`ints` is alias for `[]int`

`map` automatically inserts `coroutine::yield` into the last branch of the body

```ruby

@fn x_to_y x,y
    @map x..y, $i
        coroutine::yield i
    @
@
```

### Coroutines: Return Types and Accumulators

This will still return an array of integers, `ints` but one at a time. Coroutines have an accumulator that accumulates intermediate results. So our `x_to_y` function will still `return` and array of integers, even though it `yield`s only individual integers.

So we can do `coroutine::dispatchAll` which is much like Javascript's `Promise.All` which dispatches / runs a list of coroutines and waits until they're done. `_` placeholder for default thread count based on current machine.

```prolog
@let _15k, _10k =
    coroutine::dispatchAll _, [OneToN 15_000, OneToN 10_000]
```

## Type Inference: More than meets the compiler

One may look at a bunch of Silicon source code and notice there are no types, none visible anyways. Type annotations are optional unless they cannot be inferred.

## Errors as Values

Throwing errors is about as bad as throwing babies. Errors as values are _much_ better. Unlike `go` though, Silicon has enums and `>>=` bind for errors, `@try` that keeps the code clean.

## Effects System

Silicon has a very simple effect system with three types: `total`, `pure` and `impure`. All functions have this as the parent return type. These types dictate how safe a function is to run and if error handling etc need to be used.

There are 4 atomic effect types, you'll never see them outside exception or handlers: `ex`,`div`,`rand`,`io`.

ex = exception could be thrown
div = divergent, may not terminate
rand = not deterministic
io = outside state and manipulation

### Total

`total` meaning they have no exceptions, they do use outside state, they terminate and they are deterministic. Basically `void` or `unit` for effects as it isn't an effect.

```silicon
/// int,int -> total(int)
@fn add a,b
    a + b
@
```

### Pure

`pure` has become well known. Pure functions are deterministic, don't use outside state **but** may throw exceptions or never terminate.

```silicon
/// bool -> pure(bools)
@fn pure a
    @while a
        a
    @
@
j
// may have a DivideByZero exception
/// int,int -> pure(int)
@fn div num,denom
    num / denom
@

/// nz_int is a non-zero integer
/// int, int -> total(int)
@fn div num, denom:nonzero
    num / denom
@

/// int,int -> total(maybe(int))
@fn div num, denom
 @if denom @not 0
 @then num / denom
 @else MAYBE::NONE
@
```

### Impure

I kept the name simple. A function _may_ never terminate, throw exceptions, read or write outside state and be non-deterministic.

```silicon
/// str -> impure(str)
readFile fileName
```

### Sub-types

I may have subtypes later but this systew will work well enough. One Subtype that may be useful would be `pureIO` or pure IO. Not truly pure but at least have referential transparency

## WASI(X), POSIX, and Web API support

Silicon has first-class support for common runtime environment APIs, making adoption, migration and interopability easy.

```silicon
    @let button = web::document.getElementById("myBtn")
```

Or NodeJS readFile
```silicon
node::fs.readFile("Demo.txt", Encoding::UTF8, @fn data => node::console::log(data))
```
