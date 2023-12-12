# Basics of Silicon<sup>tm</sup>

## Partial Function Definitions

_aka Pattern Matching_

So instead of:

```silicon
@let fib n = {
    @if n <= 2
    $then n
    $else (#fib n - 1) + (#fib n - 2);
}
```

We can do

```silicon
@let fib 1 = 1;
@let fib 2 = 2;
@let fib n = {
    (fib n - 1) + (fib n - 2)
}
```

Where we directly map the output value for a given input value.

> **NOTE**: This is NOT function overloading. The function / method signature hasn't changed, nor are we adding any other implementations.

Instead of:

```silicon
@let foo n = {
  @if n @is null, {
    @exit
  }
  // code
}
```

We can do _something_ like this.

```silicon
@fn foo null = {}
```

## Parens

Silicon does NOT require parenthesis anywhere

## Keywords

All keywords start with `@`. Identifiers aren't allowed to start with `@`.

This also makes parsing Silicon inside of markup like `HTML` or `XML` easier (thanks C#).

```
@if allow_delete, {
    <button>delete<button>
}
```

## Code blocks

`{}` is a code block.

## Semicolons

Semicolons are required but are auto-inserted by the LSP, not the compiler.

## Types

**Arbitrarily sized types like Zig?**

Silicon has a sound and robust type system that map well to WASM / JS.

There are 7 base types:

`opaque` - for opaque external reference types

`vec` - v128 for WASM. For SIMD instructions.

`atom` - a type with only one value, itself. I.E `$true` and `$false` are built in atoms.

`bool` - boolean `true` or `false`

`int` - LEB128 variable sized integer, little-endian

`float` - 32/64bit IEEE 754 floating point

`decimal` - 128bit fixed point number (backed by `vec`)

`string` - UTF-16 string but can be UTF-8 or UTF-32 as well

## Reference Types

`fn` -

    In the case of funcref, which represents an opaque reference to a function, the only thing we can do from WebAssembly is to call it.

    Since reference types cannot be stored to linear memory there’s another structure allowing us to store these types: tables. Tables are the storage structure of reference types, indexed by an integer starting at zero. But they have a few more constraints than reference types. They are module-global objects, can’t be stored into the stack, locals, nor can they be arguments, or return values of functions.

## Type inference

Silicon does use true type inference. Variable types and function signatures, including effect types, are ALL inferred for you. This is a `HUGE` type savings for library devs playing _"type gymnastics"_.

`@let`, `@if`, `@for` and `@match` are expressions, when used so.

Function parameters can be implicitly typed just like any other variable. This is because with implicit returns, it could be easy for a developer to not return a value somewhere
and then the function signature changes from `int,int -> int` to `int,int-> int | void`.

Javascript<sup>tm</sup>

Silicon<sup>tm<sup>

```ruby
    /// bool -> total string
    @let fooMessage isThing = {
        @if isThing
        $then "Yes"
        $else "Nope, sorry"
    }
```

\* _There is no separate lamda or anonymous syntax. Just use `_` for anonymous functions._

## Declaration

Silicon<sup>tm</sup> uses the `@let` keyword.

    @let name:str

### Mutability and Locality

_This will be covered more thoroughly in [Advanced](./advanced.md)_

By default. All variable are immutable and local (cannot escape their scope aka the stack).

// TODO: revisit this. Most likely this modifiers will become annotations or type constructors i.e. `@let x:@mut(int)`

`@let` or `$` - local, immutable

`@m` - local, mutable

`@g` - global, immutable

`@gm` - global, mutable

    @m name:str

These are actual expressions. Which allows for things like

    @if $data = #getData
         #save db, data
    @

### Update

// TODO: again, likely `@@global`

Since I want to implement _locality_ like OCaml _but_ have `local` (stack allocation) to be the default instead. So a value can't escape its' region unless `global` was used.

I'm not sure of the keywords `@local mut` versus `@global` maybe?

## Assignment

    name = "Nathan"

## Declaration and assignment

    @let name:str = "Nathan"

### Atoms

Always start with `$`. Also know as `Symbol` which are completely unique unguessable values.
Also used for named parameters / types constructors.

    @let true = atom()
    @let false = atom()

    $true
    $false

    @let bool = $true | $false

## Algebraic Data Types

We can make new types by adding, substracting or multiplying types together
// TODO: read up on how OCaml would handle type inference here since `message` could easily be a `string` or `MessageOrFalse`.

```typescript
type MessageOrFalse = string | false;

let message: MessageOrFalse = "Hi there";
let messag2: MessageOrFalse = false;
```

### New Syntax?

```silicon
@let n = 15

@fn fizz_buzz_fn 0,0 = "Fizzbuzz"
@fn fizz_buzz_fn 0,_ = "Buzz"
@fn fizz_buzz_fn _,0 = "Fizz"

```

## Traits / Typeclasses / Interfaces

```silicon
    @type stringy:@trait 'Type = {
        @fn to_string:string a:Type
    }

    @type stringy:@impl int = {
        @fn to_string:string a:int = {
            // ...code...
        }
    }

```
