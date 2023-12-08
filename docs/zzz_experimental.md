# EXPERIMENTAL ideas

According to [this blog post](https://soc.me/languages/type-annotations) inputs should be defined before outputs. I half agree BUT in this case the function name is still defined **BEFORE** and then the _type_ **AFTER** which feel really inconsistent.

    ```
        // the type of 'add' is added AFTER the parameters?
        fn add (a:int,b:int):int { }
    ```

They type should always come after the identifier as `:type`. In order to satisfy both mine and the author's requirements here is some experimental syntax for functions and other definitions. I assume people would _loathe_ this with a passion.

## Function

The only difference below is that the function name, and type, come after the parameters. Silicon uses commas to help visually separate parameters AND no comma means that is the function name/identifier. This means no parens or brackets of any kind are needed.

#### CURRENT

    @fn add:int a:int, b:int = {
        a + b
    }

#### EXPERIMENTAL

    // int, int -> int
    @fn a:int, b:int add:int = {
        a + b
    }

Type definition with generic parameter

    // generic list
    @type 'T List = {
       item:T
       next:->List
       prev:->List
    }

#### EXPERIMENTAL 2

Closer to ML syntax using `@let` for all binding definitions.

**Function**

    // yuck
    @let add = @fn a:int, b:int _:int {
        a + b
    }

**Type**

    @let person:struct = @struct a:type {
        name:string
        age:int
    }

## Traits

```silicon
    @type stringy:@interface 'Type = {
        @fn to_string:string a:Type
    }

    @type stringy:@impl int = {
        @fn to_string:string a:int = {
            // ...code...
        }
    }
```

### Traits with output named last

```silicon
    @type 'Type stringy:@interface = {
        @fn to_string:string a:Type
   }

    //TODO: not sure which to use. Second is clearer imho.
   //@type int stringy:@impl
   //@impl int string:@interface
    @impl int stringy:@interface = {
        @fn to_string:string a:int = {
            // ...code...
        }
    }
```

## Classes vs Data Types?

I'm debating on going the more OOP route, which is what `R#st` and `Go` do with `Person::new()` and `Person.new()`, respectively.

I'm using `$()` for a list of values, since `()` just groups expressions normally. Maybe I can remove or that will be tuple syntax?

Using a class to define a `Person`.

```
    @class Person name,age,friend = {
        name:string,
        age:int,
        friend:->Person,
    }

    @impl Person self = $(

        @fn Greet name = {
            #print `Hello, ${name}`
        },

        @fn addFriend friend:Person = {
            self::friend
        }
    )
```

## Objects vs Statement groups?

How to disambiguate `{}` for key, value pairs and code blocks?

```
    // similar to OCaml data types. No Names required.  // types are still always :type
    @type Person = :string, :int, :Person

    @type Person =
        (name   :string = "Jane Doe",
         age    :int = 29,
         friend :-> Person? = $NONE)

    @fn Greet self:Person, name = {
        #print `Hello, ${name}`
    }

    @fn addFriend self:Person, friend = {
        #self.friend.add friend
    }

    // sorta like a submodule of methods
    // or a namespace but for a specific type

    // instead of @mod?
    @let friends = @impl Person, (/* ...code...*/)
    @impls Person,
   // namespaced method groups?
   // Are they methods if they use UFCS?
   // there is no dispatch?
    @mod friends self:Person = (
        @fn clear = {
            self.friend = $NONE
        },
        @fn addFriend self:Person, friend = {
            #self.friend.add friend
        }
    )

    // OR as a function
    @impl Person, (
        @fn clear self = {
            self.friend = $NONE
        },
        @fn addFriend self:Person, friend = {
            #self.friend.add friend
        }
    )

    // usage
    // setup
    @let Delfina = Person "Delfina",29, $NONE
    @let Jason = Person "Jason",32, Delfina

    // Parens for tuple / grouping?
    @let Delfina = #Person "Delfina",29, $NONE
    @let Jason = #Person "Jason",32, Delfina

    #Delfina.friends.add Jason
    #Delfina.friends.clear

    // This *IS* too much syntax
    #Delfina::friends.add Jason
    #Delfina::friends.clear

```

## Keywords

Silicon only has 15 core keywords (Go has 25). Thanks to named parameters and pattern matching, many keywords aren't needed like `case` or `default` for switch case.

1. @let
1. @cor // TODO: coroutines
1. @when (if)
1. @loop
1. @type
1. @impl
1. @skip (alternative to continue)
1. @fall (fallthrough) \* may not be needed because of pattern matching
1. @exit \* replaces 'break': return from current function / block.
1. @yeet // non-local return? since Silicon doesn't have throw
1. @dead // throw / panic? kick, konk, ends, croak, term (terminate) 
1. @select //TODO: coroutine select
1. @module
1. @import
1. @export

AND

- @and &&
- @or ||
- @not !
- @least >=
- @most <=
- @above >
- @below <
- @between start < x < end
- @within  start <= x <= end
- @outside x < val < x

Annotations

- @@mut // TODO: mutability keywords?
- @@imm // TODO: mutability keywords?
- @@wait (defer) // TODO:  implement

Execution time annotation

- @@compile (execute at compile time)
- @@execute (compile and execute at runtime)
- @@analyze (interpret and execute at runtime)

## Syntax / Symbols

- `$` atoms
- `()` group expressions are expression / key-value pairs
- `[]` list of values
- `{}` statements
- `@` keyword
- `'T` Generic indentifier
- `` `backtick` `` backticks for template strings
- `_` throw away
- `;` end of statement or expression
- `.` field access OR namespace access
- `,` separate lists
-

## Dispatch

Silicon doesn't actually have methods. "WHAT?",¨¿Qué?","что?".

Yeah. There can only be one function with a specific name in any module. Thankfully, we can differentiate them by module and still use a method-like syntax. BUT there is no dispatch. `Silicon Dynamic` _may_ have multiple dispatch though since that is kinda cool to play with in a dynamic language context.

UFCS or universal function call syntax means that you can write a function like a method call but the first parameter is the receiver.

The following example has a `swap` function that takes a string and then swaps all instances of the give pattern with the give value.

```silicon
#swap "Hello, Space", "Space", "World!" // "Hello, World!"

"Hello, Space".swap "Space, "World!" // "Hello, World!"
```

### One name to rule them all

There is only one swap function right? I can't have more than one, function overloading.

## Type-Directed Name Resolution (TDNR)

There was a [proposal to add TDNR to Haskell](https://web.archive.org/web/20160310052223/https://prime.haskell.org/wiki/TypeDirectedNameResolution). This is _REALLY_ interesting for Silicon because this would really sell the language and set it apart from being too FP or too OOP.

_// bool would be inferred as type ':bool' here._

_// int would be inferred as type ':int' here._

```
@mod int = (
    @fn toString:string value:int
)

@mod bool = (
    @fn toString:string value:bool
)

#toString x
// ERROR: ambigous function call.
// no function overloading.

// fully-qualified name
int::toString x // correct
bool::toString x // correct

// unqualified name resolution
// if X is of type int then it'll resolve to int::toString
// if X is of type bool then it'll resolve to bool::toString
x.toString

5.toString // "5"
$true.toString // "true"




```

## Parens, Braces and Brackets

|     |                                                        |
| --- | ------------------------------------------------------ |
| [ ] | encloses type parametern or type arguments             |
| ( ) | groups expressions, parameter/arugment lists or tuples |
| { } | sequence of statements or definitions                  |

## Operators

| Precedence | Operator                                        | Description                                      |
| ---------- | ----------------------------------------------- | ------------------------------------------------ |
| 1          | =                                               | Assignment                                       |
| 2          | @or                                             | Boolean Or                                       |
| 3          | @And                                            | Boolean And                                      |
| 4          | @is, @not, @below, @most, @above, @least, @deep | Comparisons                                      |
| 5          | + - @bor @bxor                                  | Addition, Substraction, Bitwise Or, Bitwaise XOr |
| 6          | \* / @band                                      | Multiplication, Division, Bitwise And            |

## `if` to rule them all

No more`switch` ?! This is like Go's `for` .

Existing `if` with named parameters `$then` and `$else`

```silicon
@if x @is 1.0
$then "a"
$else "z"
```

Multiple thens.

```silicon
@if x
    @is 1.0 $then "a"
    @is 2.0 $then "b"
    @is 3.0 $then "c"
```

As functions?

```silicon
// single
@if x @is 1.0 $then "a"

// multiple
@if x,
    .isEmpty $then "a",
    .contains(0,0) $then "b"

x.jump
 .case(isEmpty,"a")
 .case(contains x, "bbbbb)

// LISP
x.jump
 .(case isEmpty,"a")
 .(case (contains x, "bbbbb)
```

Other thoughts?

    @if x when @gte 3 then true

## `@loop` to rule them all?

Similor to `Go`'s `for` loop.

1. the **init** statement: executed before the first iteration
1. the **condition** expression: evaluated before every iteration
1. the **post statement**: executed at the end of every iteration

_NOTE: the update block does NOT mutate, think of it a recursive function call. Instead of `++i` you do `i + 1` or `i.inc`_

`@loop setup, condition, update, block`

### `for`

```silicon
// iterator, lambda
@loop 1..10, \i => {
    i
}
// iterator, function
@loop 1..10, @fn_ i = {
    i
}
```

### `While`

```silicon
@let i = 1;
@loop ,i <= 20, {
    i+=1
}
```

### `for in`

## misc

### Core

```core
fun id[T](x:T):T =
```

### Si

Too many [] and () for me

```silicon
// Function name at end
@fn [T] (x:T) id:T =

@fn [T] x:T id:T =

@fn x:'T id:T =

@let id = @fn [T] x:'T -> :T

@fn [T] id:T x:T =
```

Generic add function with name and return type after.
Parens added for clarity but aren't required.

     @fn [T] (num1:T,num2:T) add:T  = {
        num1 + num2
     }

OR

    @fn [T] add:T num1:T , num2:T = {
        num1 + num2
    }

Lamda syntax?

    @let add = \a,b -> a+b

    // parameters are assumed with \\
    @let add = \\a+b

## No Unary Operators

> "What?! What about ...?"

Silicon only has binary infix operators. This is a hard requirement that will never change in the Silicon language specification.

Typical unary operators

    -x
    -1
    ++x
    x++
    !x
    &x
    *x

None are needed.

| unary operator | alternative 1 | alternative 2     |
| -------------- | ------------- | ----------------- |
| -x             | x.neg         | 0 - x             |
| -1             | 1.neg         | 0 - 1             |
| ++x            | x += 1        | x.inc             |
| x++            | x.post_inc    | @defer x += 1; x; |
| !x             | @not x        | x.not             |
| &x             | @val x        | x.val             |
| \*x            | @ref x        | x.ref             |

Instead of `&x++` we can do `x.val.pinc`

Silicon prefers methods over operators.

So no fancy Pratt parsing or Pika Parsing needed to handle prefix or postfix operators, they DON'T exist!

_\*sigils aren't operators_

## SI puts the SI in Simple.

- no unary operators
- no operator overloading
- no inheritance
- no function / method overloading
- no modifier keywords (just annotations)
- few keywords that are prepended with `@`
- no garbage collector: reference counting / borrower checker (optional)
- ONE looping construct `@loop` (for, while and do/while)
- ONE condition construct `@when` (if and switch/case)

## What SI DOES have

- Traits (because they're awesome)
- Annotations (for flexiblity)
- UFCS (no real methods)
- TDNR (fake overloading)
- ADT (the best type of type)
- SIMPLE and consistent syntax
- coroutines: no locks, semaphores or runtime to schedule
- Pattern matching
- Full type inference!
- Full lifetime inference!
- Cross-Compilation!
- C interop!
- 100% Web API coverage
- 100% Node API coverage

## Annotations

Again, inspired from the same blog. I already was thinking of the common
syntax that Java has and works well with Silicon.

```silicon
@@annotation
@let name:string = "Nathan";
```

## Semicolons; Let's talk.

I think most devs would agree that automatic semicolon insertion is table stakes for any new language.

Silicon is NOT prioritizing this, YET, but it should be quite easy because Silicon's grammar is so simple and regular.

I do think the better method is to have the official Silicon LSP, Sgl_lsp, automatically insert semicolons for the developers without messing with the language's grammar which make it more complex for other language tooling.

### Algorithm

End of lines add `;` **UNLESS**:

1. Current Line

   a) ends with `,`, `.`

   b) within unclosed `()`,`{}`, `[]`, `""` or ` `` `.

2. next line

   a) start with `,` or any binary operator `+`,`-`,`*`,`**`,`/`, `++`

**SAD** but unfortunately this would completely break my cool DSL syntax for function with named paratemers IF

    @if true,1,0;

    @if true,
    then=1,
    else=0;

    @if true
    $then 1
    $else 0;

## Keywords

### 7 Letter annotations

- compile (execute at compile time)
- execute (execute at runtime)
- analyze (interpret at runtime)

### 6 Letter

- module
- import
- export

### 5 Letter

- class
- value (struct)
- union
- trait
- alias

### 4 letter

- when/then/else
- loop (while)
- exit (return)
- give (yield)

### 3 letter

- fun
- let

For Result type, `pass` and `fail`

## MISC

Reverse Polish Notation Grammar

    // DEFINITION
    @fun [T] (a:T,b:T) add:T = {
        a + b
    }

    // IMPLEMENTATION
    #[int] (1,2) add // 3

    // # Sigil
    # 1,2 add

    // UFCS
    (1,2).add

OR NOT

    // DEFINITION
    @fn add:'T a:T,b:T = {
        a + b
    }

    @fn add:int a:int,b:int = {
        a + b
    }

    // IMPLEMENTATION
    add:int 1,2 // 3
    #add:int 1,2 // 3
    @exe add:int 1,2 // 3

## Forth option?

Forth is an old stack based language. Extremely easy to parse because the syntax follows that of the stack operations. **IF** Silicon did adopt the reverse Polish notation style, it could make parsing even easier BUT it wouldn't be in any way like _FORTH_ lol.

Reverse Math

```si
(1,2).add // 3
(1,2,3).sum // 6
(1,2,3).mult.add // 7
```

```
// Si in more C style
@let x = -1;
-x.abs;

// No unary operators
@let x = 0-1; // or 1.neg
x.neg.abs;
```

C Return Postfix

```c
return x++;
```

Silicon

```silicon
#x.pinc
```

## Algebraic Data Types

    @type RGB = RED | GREEN | BLUE
    @type My_list:'a = NONE | List:'a * my_list:'a

## IF, WHEN, JUMP, CASE

    @if condition, then_block, else_block
    @if (true, "Correct") // else is a NOP by default

    // with named parameters
    @if true $then "Correct" $else "Incorrect"

IF Silicon allows capture syntax then maybe I could do this:

    @if |x|
       @is NONE             $then 1
       @gte 5               $then 1
       @below NONE          $then 1
       .name.contains "son" $then 1

Make it fit with function syntax?

    @when X
       @is NONE             $then 1
       @gte 5               $then 1
       @below NONE          $then 1
       .name.contains "son" $then 1

or

    x
        .case @is null, 1
        .case @gte 5, 1
        .case @below 10, 3

## Pattern Matching with methods?

    switch (x){
        case null: value; break;
        switch x.name: {
            case "John": value; break;
        }
    }

INTO

    x.case(null,value)
     .jump(x.name
     .case("john", "found you")
     .case(\name,"hi, " ++ name)
     )

Or pipe syntax

    x |> case null,value
      |> jump name, case "John", true

## Defer

Instead of `defer list.deinit()` like in Zig. I'd love if it was automatic with the `defer` keyword.

`@defer std::list` will automatically call `defer list.deinit`

## Sigils

The toolchain is named `sigil` because Silicon uses a handfull of special characters to add special meaning. Sigils are not operators. They don't _do_ anything other than distinguish the type of identifier or expression.

- `@` prepended to all keywords.
- `@@` prepended to all annotations.
- `$` prepended to all atoms or named parameters.
- `#` prepended to function calls. \* this may change.

  @if true, {
  "true"
  }

  @fn fib 1 = 1
  @fn fib 2 = 2

  @@memo
  @fn fib n = {
  (#fib n - 1) + (fib n - 2)
  }

  @type bool = $true | $false

## Annotations `@@`

Silicon doesn't have built-in modifiers like `public`,`private` etc. Both because it is not
an OOP language and because modifiers would have to be _annotations_.

Annotations do use a new **sigil** `@@`.

    @@my_annotation
    @let x = 42;

Annotations provide a lot of flexibility in the language.

## Identity & Equality

Taken form [karlsruhe](https://soc.me/languages/equality-and-identity-part3)'s blog.

### Defining Equality and Identity

 - **Equality** checks whether two things are equal, based on some library-defined definition of equality.

- **Identity** checks whether two things are identical, based on a built-in definition of identity."

Every language has a way to compare things. There are two types of comparison though: referential equality and value equality.

`==` and `@eq` - checks whether two things are equal, based on some library-defined definition of equality.

`===` and `@is` - checks whether two things are identical, based on a built-in definition of identity.

`equality` = **language** definition.

`identity` = **user / library** definition.

So by default a type doesn't have `identity` defined i.e.

> only available when the type is constrained appropriately 

    @fn same[E : Identity](a: E, b: E) = { a === b }



## Lamda Syntax and Pattern Matching

Silicon has one new grammar ! I know that's a 25% increase lol. I figured Silicon needed a less verbose version of function definitons for lambdas and patterning matching. Don't worry, it is still dead simple.

    \param1,param2 => body

Let's define a simple add function

    \num1,num2 => num1 + num2

Lambda syntax is the **ONLY** exception to the rule where `{}` are required for a code block, they are assumed.

### IIFE 

Silicon does have IIFEs, kinda like JS. We can define an inline function then immediately use it.

    #(\a,b=>a+b) 1,2 // 3

Pipe syntax works too if we want the parameters to come first. Handy for pattern matching / switch case.

    1,2 |> (\a,b=>a+b) // 3

## Prevent let + function literal

I don't want the JS styled

    @let add = @fn _ a,b = { a + b } // error: cannot assign anonymous function literal 

    @let add2 = @fn add1 a,b = { a + b } // error: cannot assign named function literal

I could simplify the language further by dropping the function keyword, `@fn`, all together. It feel a little bit too ML style. The grammar wouldn't change at all just `@fn` would be swapped with `@let`, that's it.

Function keyword (I was going to do `@fun` for better alignment)

    @fun add:int a:int,b:int = { a + b }

Let keyword

    @let add:int a:int,b:int = { a + b }

Sometimes functions are not function?

    @let x = { 1 + 2 }

    // coverted to 
    @let x = 3

Lamda syntax? **NOPE**

    \a,b = a + b


