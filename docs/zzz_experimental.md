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
        .case(\x => x.isNull, 1)
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

## Defer / Drop Trait

Silicon could have '@defer' like in Zig. I'd love if it were automatic though.

Silicon will have traits so couldn't I implement a drop trait?

`@defer std::list` will automatically call `defer list.deinit`. Rust has a drop trait so maybe that would be possible here too.
or the constructor functions could put `defer list.deinit` into the parent scope (like Jane Street OCaml's `exclave` keyword).

### IIFE

    #{@fn_ a,b = {a + b}}

    1,2 |> @fn_ a,b = {a + b} // 3

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

## Return, Break, Yield

Return from function scope
Leave block scope
Leave parent block scope
leave parent function scope

### Potential fixes / simplifications

I could make silicon function scoped like 🤮.

Make function scope = block scope as if it isn't special? They're just stacks.
So `@exit` means leave block scope or function? Early returns would be difficult then.

1. Break block scope `@exit`
1. Break parent block scope (I could use labels? or set parent condition properly).
1. Return from function scope `@give`
1. Return from parent function scope (via monads not keyword) `@give #Done value`

### Break block scope

While this isn't needed 95% of the time, it is still needed.

## Break parent block

This can be done in a few ways

- return / yield from function
- set condition of inner loop to stop
- labeled statements

## Return from function

This is generally needed but can be replaced in many cases with

- function parameter pattern matching
- implicit returns

## Return from parent function

This is something I want in Silicon but it doesn't necessarily have to be a keyword. In fact, a keyword may be worse
as it would be similar to a goto and the caller wouldn't know if the callee forces the parent to return which is a bit too
much abstraction.

- return wrapped type (monad) to parent to indicate to return early
- a special keyword

```silicon
    array.map @fn_ index,value = {
        @if index == 10
        $then {
            (
                value:index,
                done:false
            )
        }
        $else {
            (
                value:index,
                done:true // tell the parent function (internal iterator) that we're done.
            )
        }
    }
```

Parent function

```silicon
@fn map array, func = {
    @let done = false;
    @loop 0..array.len, @not done ,@fn index, value = {
        #func index,value
    }
}
```

## Ruby Blocks

This is the best way I can explain the feature. I _originally_ wanted simply `non-local returns` in the sense
that when I was doing Advent of Code last year, 2022, in Javascript but with a functional style, I noticed that I couldn't
return early from `map`, `reduce` or `filter`. I learned that those are [internal iterators](https://journal.stuffwithstuff.com/2013/01/13/iteration-inside-and-out/) and while they're quite powerful, they're really nerfed if they aren't coupled with _non-local returns_. I then learned from that same blog post that _Ruby_ of all languages has this feature **AND** that feature called [Ruby blocks](https://yehudakatz.com/2010/02/07/the-building-blocks-of-ruby/) can do _A LOT_ more than just that.

Again, I'm still new to this concept and I've only used Ruby for DevOps stuff early in my career so I'll have to fire up a new Ruby project and play with it. What I've seen so far is _really_ impressive. Ruby blocks have cool features like being able to wrap code in a _block_ and it doesn't change anything semantically. Ruby is also able to use _ensure_ keyword to literally ensure that cleanup code is run, even if an exception is thrown! I'm not sure what the ML equivalent to that is though. I'm sure if exceptions are just values then using a monadic approach one could wrap the cleanup logic in a monad too.

Either way, Ruby blocks seem really powerful, intuitive (code works the same after wrapping it in a block) and versatile. Exactly the kind of language feature that Silicon cares about. Even if, most of the uses for blocks can be emulated with other language features, especially ML language features like Monads, it is good to have some variety that take a different approach.

### Silicon Blocks / Lambdas

Silicon will use a `\params = { }` syntax. Blocks are anonymous inline function without any context of their own. This is why `@return` and `@yield` work the same inside a block as they do outside one.

**Add block**

    \a,b = { a + b }

Pass a block to a function

    @fn binary_op a, b, block = {
        #block a,b
    }

Function declaration (all definitions but not value literals?) are statements and therefore cannot be aliased. No `@let add = @fn _ a,b = { a + b }` nonsense. Lambdas, however, MAY be aliased since they by default have no name and are expressions `@let add = \a,b = { a + b }`.

### Blocks vs Functions

functions are statements.
lamdas are expressions.
blocks are functions or lamdas (sum type of both).

Hopefully, I wrote about this before somewhere else in the docs. I solved an issue, I don't remember the issue. with blocks vs function by treating them basically the same; they share a parent type. Maybe they have a shared parent type which the type system can use to have functions and blocks to be interchangeable, generally anyways.

`:function` - a function type
`:lamda` - a lambda type
`:block` - sum type that includes `function` and `lamda` types.

Definition of a block type

    @type block = function @or block

### `ensure`

One concern that I had with blocks / lambdas is if a block can return for the parent's scope (function) then the parent function cannot guarantee important cleanup code in run i.e. close a DB connection. Ruby is actually a pretty cool language that already though of this and uses the `ensure` keyword to literally _ensure_ code runs after executing a block (they yield a block which is weird to me). So `@ensure` will likely be a keyword.

Blocks can add safety and flexibilty to the language while also not semantically changing code this is or is not inside a lamda (Ruby block).

## Parallellism

This isn't really an experimental concept. This is more a technique one could use _after_ compiling `Silicon` to `wasm`. But since Silicon focuses on being a full-stack web dev language and having both Ecmascript and Node interop, then being single-threaded makes sense. Co-routines are really powerful, don't [color functions](https://journal.stuffwithstuff.com/2015/02/01/what-color-is-your-function/) and allow for shared mutability without resorting to complex locking technique, mutexes and semaphores.

All that said, sometimes one _needs_ true parallelism or at least to run the same program in multiple instances to take full advantage of multiple CPU cores. Silicon can easily do this since it runs on WASM and we can just launch N Instances where N is the CPU / vthread count of the machine. I'll likely add some tooling, docs, support etc to help make this easier. Again, since we are really only thinking about web dev then a webserver really doesn't often need to do true parallelism in the sense of shared state. The only _"shared state"_ is the database. I think this solve the problem eloquently and simply for the majority of use cases. See the following _Workers_ section for an alterative.

### Workers

`Silicon` has 100% Ecmascript / Node API support. This means `workers` can also be used inside `Silicon` programs. _Though_ there _may_ be some restrictions due to the effect type system like only using `workers` in a special function. There may be a `:Parallel` effect type for just this type of code. It is encouraged to keep inside of a parent co-routine and separate from other I/O and other code. I'll have to flush out this technique more.

## Comments with `//` problem

This isn't a skill issue but more a clean parsing issue. I am parsing Silicon one character at a time. It is weird if I have a `parseOperator` function that accepts `/` but then finds another `/` and has to pass that to a `skipComment` function.
 
To `solve` this. I'm thinking of making `#` for comments, no longer for function calls. That way `//` would still be an operator (same category of Token) just like how `*` is multiply and `**` is power, `/` can be divide and `//` can be integer division (Python etc. does this).

I don't think I need a Sigil for function calls, if I do I'll swap `#` out for `&` probably since both `Powershell` and `Perl` use it and Silicon does't use it as an operator. `PHP` uses `\` but I want to use that for Lambda definitions. `\a,b = a + b;`. I _could_ use `\` for function calls and `\\` for _lambda_ definitions. Though that would be the __ONLY__ definition is Silicon that uses an operator (symbol) instead of a keyword for a definition. `@fn add a,b = {a+b;};` then lambda `@lambda a,b = a + b;`. I could do `@fn _ a,b = a+b;` or `@_ a,b = a + b;`

LAMBDA options

1. `@fn _ a,b = { a + b; };` 6 characters before parameters
1. `@_ a,b = { a + b; };`    3 characters before parameters
1. `@_ a,b = a + b;` 3 characters before parameters, no `{}` needed for body.
1. `\a,b = a + b;` 1 character before parameters.
1. `@\a,b = a + b;` 2 characters before parameters, and `@`


```silicon

// 1,1,2,3,5,8,13,21,34,55,
@fn fib 1 = 1;
@fn fib 2 = 1;
@fn fib n = {
    # without function call Sigil
    (fib n - 1) + (fib n -2);
    # with function call Sigil
    (&fib n - 1) + (&fib n -2);
};

# get 10th fibonacci number
&fib 10; // 55
```

If I stick with `@fn _` for lambdas, then I _could_ use `\` as a Sigil for function calls 

`\foo bar,baz;` versus `&foo bar,baz;`. The latter looks better to me. The former is _too_ commonly used to declare Lamdas. Likely I'll use `@\` for lamdas as that will follow the Specification "all definitions __MUST__ use a `@` keyword". `@\` may be special in that it doesn't need nor expect whitespace after, it'll be greedily matched. So that `@\a,b=a+b;` would be valid syntax. I _MAY_ add that to the specification that keywords made of only special characters _MUST_ be greedily matched.

> "All _definitions_ __MUST__ use `@` identifier"




