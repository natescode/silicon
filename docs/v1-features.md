# v1.0 Features


1. Targets WASM
1. Custom allocators `zig`
1. Comptime `zig`
1. Quote / Unquote macros for Hygenic Procedural Macros `lisp`
1. Sum types `ML`
1. Pattern Matching `ML`
1. Coroutines `Lua`
1. Yield Semantics
1. NO GC / Runtime *GC Optional
1. Perceus Reference Counting `Koka`
1. Type Inference `ML`
1. Errors as Value
1. WASI(X), POSIX, and Web API support
1. Effects `Koka` ??
1. Immutable, Total / Pure, and Stack allocated by default

`Koka` Core features include 
- first-class functions
- a higher-rank impredicative polymorphic type and effect system
- algebraic data types
- effect handlers.


## WASM

Why WASM ? Because it is fast, secure, and universal.


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

`@comp` is the keyword for comptime.


## Quote

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

## Coroutines

```silicon
co::new @fn add a,b => a + b
```

## Implicit Returns

Implicit returns doesn't mean implicit values.

## Yield Semantics

Silicon tries to make using coroutines as easy as possible. Calling a function as a coroutine should be as similar as calling it 

`async / await`

we can `await` any function. Functions are both async and sync. Await will run the function in a coroutine and wrap the result in a promise.
