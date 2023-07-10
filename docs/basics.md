# Basics

## Comments

### C style comments

    // single line comment
    /*
        Multi-line
        Comment
    */

### Doc Comments

Doc comments are used for Sigil's built-in auto documentation feature.
They can define function type signatures as well if the function doesn't have types.

Function type signatures use Haskell-like syntax with `->` BUT since function are not auto-curried (they can have multiple parameters) we can have a comma separated list of parameter.

```typescript
    /// number, number -> number
    @fn add a,b
        a + b
    @
```

Versus

```typescript
    @fn add:number a:number, b:number
        a + b
    @
```

## Parens

Silicon does NOT require parenthesis anywhere. They are ONLY used for grouping.

`$()` is tuple syntax though.

## Keywords

All keywords start with `@`. Identifiers aren't allowed to start with `@`.

## Code blocks

While `{}` may be used. `@` blocks are preferred.

instead of

    @if true {
        // code
    }

Silicon does

    @if true
        // code
    @

## Semicolons

Semicolons are automatically and intelligently inserted

## Type inference

Silicon does use type inference a lot BUT function signatures MUST be explicitly typed. Function signatures are interfaces which should be explicitly typed.

Function have implicit returns. `@let` `@if` `@for` etc are expressions.

Javascript

```javascript
@const thing:string = isThing:bool => isThing
    ? "Yes"
    : "Nope, Sorry"
```

Silicon

```typescript
    /// bool -> string
    @fn thing isThing
        @if isThing
        @then "Yes"
        @else "Nope, sorry"
    @
```

OR

```typescript
    @let thing:string isThing:bool => @if isThing
    @then "Yes"
    @else "Nope, sorry"
```

Lamda syntax

```typescript
    /// bool -> string
    @fn thing isThing =>
    @if isThing
    @then "Yes"
    @else "Nope, Sorry"
```

## Declaration

Silicon uses the `@let` keyword.

    @let name:str

`@mut` for mutable variables.

    @mut name:str

These are actuall expressions. Which allows for things like

    @if @let data = #getData
        #db.save data
    @

## Assignment

    name = "Nathan"

## Declaration and assignment

    @let name:str = "Nathan"
    $name = "Nathan"

Atoms

~~Always start with `$`~~. Also know as `Symbol` which are completely unique unguessable values.

    @let true = atom
    true
    false

    @let bool = true | false

## Conditionals

### IF

Silicon has if expressions

    @if true
        #print "it is certain!"
        "it is certain"!.print
    @

Used as expression

    @let age = @if true @then 32

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

    a @is 3
    a @not 3
    a @above 3
    a @below 3
    a @least 3
    a @most 3

## Loops

Silicon has one overloaded `@loop` construct. They are also expressions.

    // grammar
    Loop = "@loop" capture (seriesExpr | boolExpr)

### FOR

For loop 1 to 100. Print the numbers.

// OR $ denotes passing a literal character to use as an identifier aka capture

    @loop $i, 1..100
        #print i
        i.print
    @

### FOR with step

For loop with step 2 with range syntax

    // 1,3,5,7,9,11...
    @loop $1, 1..3..100
        #print i
    @

### WHILE

    @loop $1, i < 100
        i += 1
        #print i
    @

### DO WHILE

    @loop $i
        i += 1
        #print i
        @if i >= 100 @then @break
    @

## FUNCTIONS

Again parenthesis aren't needed. Functions use `@` blocks too. Remember, function signatures MUST have types. A `doc` comment can be used instead for the type definition.

Add function

    /// num,num -> num
    @fn add a,b
        a + b
    @

With types

    @fn add:num a:num, b:num
        a + b
    @

    #add 10,20

### Ambiguous function calls

We might see something like this in a C-like language

    fib(n - 1) + fib(n - 2)

Silicon uses parenthesis like LISP

   (fib n - 1) + (fib n - 2)
