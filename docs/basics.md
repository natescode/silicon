# Basics of Silicon<sup>tm</sup>

## Comments

### C style comments

    // single line comment
    /*
        Multi-line
        Comment
    */

### Doc Comments

Starts a line with `///`

Doc comments are used for Sigil's built-in auto documentation feature.
They can define function type signatures as well if the function doesn't have types.

Function type signatures use Haskell-like syntax with `->` BUT since function are not auto-curried (they can have multiple parameters) we can have a comma separated list of parameter.

```typescript
    /// number, number -> total:number
    @fn add a,b
        a + b
    @

    // V@ syntax
    @fn add a,b = {
        a + b
    }
```

Versus

```silicon
@fn add:number a:number,b:number = {
    a + b
}
```

## Function Definitions with pre-defined values

So instead of:

```silicon
@fn fib n = {
    @if n <= 2
    @then n
}
```

We can do

```silicon
@fn fib 1 = 1
@fn fib 2 = 2
```

Where we directly map the output value for a given input value.

> **NOTE**: This is NOT function overloading. The function / method signature hasn't changed, nor are we adding any other implementations.

Instead of:

```silicon
@fn foo n = {
  @if n === null, {
    return
  }
  // code
}
```

We can do _something_ like this.

```silicon
@fn foo $NONE = {}
@fn foo $NONE = $NOP
```

## Parens

Silicon does NOT require parenthesis anywhere

_tuple syntax ?_

## Keywords

All keywords start with `@`. Identifiers aren't allowed to start with `@`.

This also makes parsing Silicon inside of markup like `HTML` or `XML` easier (thanks C#).

```
@if allow_delete, {
    <button>delete<button>
}
```

## Code blocks

While `{}` may be used.

instead of

```javascript
// Javascript
if (true) {
  // code
}
```

Silicon does

    @if $true, = {
        // code
    }

## Semicolons

Semicolons are automatically and intelligently inserted

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
    @fn fooMessage isThing = {
        @if isThing
        $then "Yes"
        $else "Nope, sorry"
    }
```

~~There is no separate lamda or anonymous syntax. Just use `_` for anonymous functions.~~

Use `\param1,param2 => {/*body*/}` for lambda syntax.

## Declaration

Silicon<sup>tm</sup> uses the `@let` keyword.

    @let name:str

### Mutability and Locality

_This will be covered more thoroughly in [Advanced](./advanced.md)_

By default. All variable are immutable and local (cannot escape their scope aka the stack).

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

Since I want to implement _locality_ like OCaml _but_ have `local` (stack allocation) to be the default instead. So a value can't escape its' region unless `global` was used.

I'm not sure of the keywords `@local mut` versus `@global` maybe?

## Assignment

    name = "Nathan"

## Declaration and assignment

    @let name:str = "Nathan"
    $name = "Nathan"

### Atoms

Always start with `$`. Also know as `Symbol` which are completely unique unguessable values.

    @let true = atom()
    @let false = atom()

    $true
    $false

    @let bool = $true | $false

### Deconstructing Assignment

We can also mix and match new declarations

```silicon
    @mut a:int

    // a is assigned
    // b is declared AND assigned
    a, $b := #getResults
```

## Conditionals

### IF

Silicon has if expressions

    @if $true, {
        print "it is certain!"
        "it is certain"!.print
    }

Used as expression

    @let age = @if true @then 32 @else 0

## IF THEN ELSE

    @if condition
    @then value
    @else other_value

## Logic

Silicon has `==` and definitely not `===`. `@is` and `@not`

    $age = 32

    @if age == 32
    @if age @is 32

    @if age @is 32
    @then "we're the same age!"
    @else "we're aren't the same age".print

@gt @lt @gte @lte

You can use `≥≤≠` but words are preferred.

`Silicon` generally uses `@is`, `@not`, `@above`, `@below`, `@least` and `@most` instead of `==`, `!=`, `>`, `<`, `>=` and `<=`, respectively.

    a @is 3 // a == 3
    a @not 3 // a != 3
    a @above 3 // a > 3
    a @below 3 // a < 3
    a @least 3 // a >= 3
    a @most 3 // a <= 3
    a @between 1 @and 5 // a > 1 && a < 5
    a @in 1..5 // a >= 1 && a <= 5
    a @outside 1..5 // a < 1 && a > 5

## Loops

// TODO: FLUSH this out. More ZIG / GO like?
Silicon has one overloaded `@loop` construct. They are also expressions.

    // grammar
    Loop = "@loop" capture (seriesExpr | boolExpr)

### FOR

For loop 1 to 100. Print the numbers.

// OR $ denotes passing a literal character to use as an identifier aka capture

    @loop $i, 1..100
        print i
        i.print
    @

### FOR with step

For loop with step 2 with range syntax

    // 1,3,5,7,9,11...
    @loop $1, 1..3..100
        print i
    @

### WHILE

    @loop $1, i < 100
        i += 1
        print i
    @

### DO WHILE

    @loop $i
        i += 1
        print i
        @if i >= 100 @then @break
    @

## FUNCTIONS

Again parenthesis aren't needed.

Add function

    /// num,num -> num
    @fn add a,b = {
        a + b
    }

With types

    @fn add:num a:num, b:num = {
        a + b
    }

    #add 10,20 // 30

_\*I'm still debating on function call syntax if `()` are needed and if `#` sigil should be used_. I know sometimes function calls could be ambigous without parens BUT which bothers me but 90% of the time that is cleaner. PLUS to disambiguate, parens are simply used to group so there aren't any special semantics.

### Ambiguous function calls

We might see something like this in a C-like language

    fib(n - 1) + fib(n - 2)

Silicon uses parenthesis like LISP because the above could mean

`fib(n-1 + fib(n-2))` or `fib(n) - 1 + fib(n) - 2` etc...

Silicon can disambiguate with `()`

```lisp
(fib n - 1) + (fib n - 2)
```

Generally, this doesn't happen and removing parens in much easier to read.

```c
foo(bar(baz),baz(bar))
```

Versus

```lisp
(foo (bar baz), (baz bar))
```

With Pipes

```lisp
(bar -> baz, baz -> bar) -> foo
```

## Algebraic Data Types

We can make new types by adding, substracting or multiplying types together
// TODO: read up on how OCaml would handle type inference here since `message` could easily be a `string` or `MessageOrFalse`.

```typescript
type MessageOrFalse = string | false;

let message: MessageOrFalse = "Hi there";
let messag2: MessageOrFalse = false;
```

## Match

`match` is like the super-saiyan version of `switch`.

```silicon
@fn fizzbuzzMessage n
    @match n%3,n%5
        0,0 => "Fizz Buzz"
        0,_ => "Fizz"
        _,0 => "Buzz"
    @
@

#fizzBuzzMessage 15 // "Fizz Buzz"

```

### New Syntax?

```silicon
n <- 15

@fn fizz_buzz_fn 0,0 = "Fizzbuzz"
@fn fizz_buzz_fn 0,_ = "Buzz"
@fn fizz_buzz_fn _,0 = "Fizz"

@match [n%3,n%5], fizz_buzz_fn
```

Defining the function inline?

```silicon
@match [n%3,n%5]
    @case 0,0 => "Fizzbuzz"
    @case 0,_ => "Fizz"
    @case _,0 => "Buzz"
```

The definiton of `@match`

```silicon
@fn match:@@KEYWORD values:Array:'T, case:fn
```

Usage

```
@match $value a $value b $case lambda $case lambda

```
