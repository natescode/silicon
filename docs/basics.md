# Basics

## Comments

C style comments

    // single line comment
    /*
        Multi-line
        Comment
    */

## Parens

Silicon does NOT require parenthesis anywhere. They are ONLY used for grouping.

`$()` is tuple syntax though.

## Keywords

All keywords start with `@`. Identifiers aren't allowed to start with `@`.

## Code blocks

While `{}` can be used. `@` blocks are prefered.

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

Silicon does use type inference a lot BUT function signatures MUST be explicitly typed.

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

## Conditionals

### IF

Silicon has if expressions

    @if true
    #print "it is certain!"
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

    @if age @is 32
    @then "we're the same age!"
    @else "we're aren't the same age"
    // => pipes if value to the `print`
    => #print

Greater_than, less_than, greater_than_or_equal_to

You can use >= <= != but words are prefered.

`Silicon` generally uses `@is`, `@not`, `@above`, `@below`, `@least` and `@most` instead of `==`, `!=`, `>`, `<`, `>=` and `<=`, respectively.

    a @is 3
    a @not 3
    a @above 3
    a @below 3
    a @least 3
    a @most 3

## Loops

### FOR

For loop 1 to 100. Print the numbers.

    @loop 1..100 , $i
        #print i
    @

### FOR with step

For loop with step 2 with range syntax

    // 1,3,5,7,9,11...
    @loop 1..3..100 , $i
        #print i
    @

### WHILE

    @loop @mut i = 0, i < 100
        i += 1
        #print i
    @

### DO WHILE

    @loop @mut i = 0
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

    @fn add:num a:num b:num
        a + b
    @

    #add 10,20

### Ambiguous function calls

We might see something like this in a C-like language

    fib(n - 1) + fib(n - 2)

Silicon uses parenthesis like LISP

    (#fib n - 1) + (#fib n - 2)
