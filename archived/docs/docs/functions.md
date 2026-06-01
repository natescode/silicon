## FUNCTIONS

Parenthesis and types are optional. The function is the main abstraction in Silicon. Due to this, function have a few superpowers.

## Parenthesis

Silicon grammar doesn't use parethesis for anything but grouping expressions, and S-expressions.

## Types

ALL types in Silicon are inferred. They can be optionally included after the identifier with `:type` syntax.

## Implicit returns

Silicon has implicit returns. `Rust` is a modern example of this. You can still use the `@return` keyword for explicit returns. Silicon does **NOT** have *implicit values*. This means that a branch of code cannot return nothing to mean `undefined` or `null` like in JavaScript. We must explicitly return a value.

```
@fn foo = {
    &if bar 
    $then 1
    $else {
      # error. We must explicitly return a value here
    };

};

### Ambiguous function calls

We might see something like this in a C-like language

    ```c
    fib(n - 1) + fib(n - 2)
    ```

Silicon uses parenthesis like LISP because the above could mean

`fib(n-1 + fib(n-2))` or `fib(n) - 1 + fib(n) - 2` etc...

Silicon can disambiguate with `()`

```lisp
(fib n - 1) + (fib n - 2)
```

Generally, this doesn't happen and removing parens in much easier to read. Sigil will warn about ambigous expressions like this.

## Function Definition Pattern Matching (FDPM)

Function Definition Pattern Matching means function parameters can be defined with values. Basically mapping inputs to pre-defined outputs. We can
implement an if expression to work with booleans this way.

```silicon
# ? means else is optional
@fn if true, then, else? = { #then; };
@fn if false, then, else? = { #else; };

# default parameters? Can't use '='. Use ';'?
# @fn if bool, then, else=null; =  { }

#if true, { #print "I'm working"; }, {#print "Not functioning";};
```

**NEW ADDITIONS**

Instead of this

```silicon
@fn fizzbuzz 0,0,_ = 'fizzbuzz';
@fn fizzbuzz 0,_,_ = 'fizz';
@fn fizzbuzz _,0,_ = 'buzz'
@fn fizzbuzz _,_,index:string = index;
```

We can do this.

```silicon
@fn fizzbuzz three, five, index:string = [
    0,0,_ = 'fizzbuzz';
    0,_,_ = 'fizz';
    _,0,_ = 'buzz';
    _,_,m = m;
];
```

OR maybe

```silicon
@fn fizzbuzz |= 0,0,_ = 'fizzbuzz'
             |= 0,_,_ = 'fizz'
             |= _,0,_ = 'buzz'
             |= _,_,m = m;
```

The `|=` operator would signify we are assigning multiple params-body pairs, sorta like switch case.

a switch case / match equivalent can be created by piping values into an anonymous function that pattern matches.
```silicon
a,b,c | @fn _  |= 0,0,_ = 'fizzbuzz'
               |= 0,_,_ = 'fizz'
               |= _,0,_ = 'buzz'
               |= _,_,m = m;
```


## Named Parameters

In the last example we defined a simple 'if' function. We can make 'if' work with more of a DSL by using
Silicon's named parameter syntax. `$` Sigil defines atoms which are named parameters or types that have only one value, themselves i.e. `$true`.

We could call `if` with named parameters instead. They then act like keywords. I may default these parameters to be inside `{}` implicitly since normally
just passing in code mean it runs immediately and it isn't a block.

Instead of 

```silicon
&@if $true,
then = #print "I'm working",
else = #print "Not functioning";
```

We can remove the `=` and the `,` and just use `$` for the parameter names. Notice that the first parameter `condition` isn't named. Silicon will use position to map arguments to parameters if no explicit name is given.

```silicon
&@if $true
$then #print "I'm working"
$else #print "Not functioning"
```

## Pipes

**TODO**

## Type Defined Name Resolution

This is explained elsewhere but it is related to functions / methods. Silicon doesn't allow function/method overloading (Silicon dynamic aka `Sulfur` does).
This may feel limiting, it is. So Silicon tries to make it a little better by fixing some cases.

Before defined our `boolToString` function/method before but it has to have its own unique name. We couldn't make it just `ToString` like we could if we had function/method overloading. We can simulate this with TDNR by allowing the type of the method reciever to dictate which module we use.

For example

```silicon
@module bool = {
    
    
    

    @fn ToString bool = {
        &if bool
        $then "true"
        $else "false"
    };
};
```

We can then use this function with its full name

```silicon
    &bool::ToString true # "true"
```

We could possibly run into an ambigous function call error if we used UFCS though.

```silicon
    @let foo = true;
    &foo.ToString # Error: 'ToString' function is ambigous between 'bool::ToString' and 'number::ToString'...
```

**NOTE** The method syntax changed from '.' to `|` (pipe). Nothing else changes in this context.

This can be fixed if Silicon looks at the type of the method receiver, `foo` in this case, and uses that information
to look inside the correct module (namespace).

```silicon
    @name foo = true;
    @name bar = 10;

    # calls Boolean::ToString
    &foo.ToString # "true"

    # calls Number::ToString
    &bar.ToString # "10"
```

So this makes the lack of proper function overloading a bit less painful. Again, if we _really_ need true function overloading we could
use `Sulfur`, Silicon's dynamic dialect.

```silicon
@@dynamic {
    @fn ToString bool:boolean = {};
    @fn ToString Number:number = {};

    @let x = true;
    &x.ToString; # "true"
}
```

Basically, it dynamically dispatches all the proper calls depending on the type.

## Default Parameters

The current grammar supports this. Which also would support _all_ inline definitions as parameters.

```silicon
    @fn foo x,@let y = 3 = {};
```

Without default parameter is would just be

```silicon
    @fn foo x,y = {};
```

Recent grammar changes now allow `()` around args/params

```silicon
    @fn foo (x,y = 3) = {};
    @fn foo x,y = 3 {};
    @fn foo x,y = 3; = {};
```

I prefer doing the `@@pre`` macro which runs just before a function recieves its arguments.

```silicon
    @@pre y = 3;
    @fn foo x,y = {};
```


## Wrappers

Silicon is a functional language so of course functions are first-class values to create High-Order functions.
Silicon has native syntax for creating high order functions via `wrappers` aka annotations in
other languages.


```silicon
@@capabilities IO
@fn hello_world = {
  IO::print 'Hello, world!';
};

&hello_world;
```

No different than

```silicon
@fn io_wrapper IO, fn ={
    &fn
}
@fn hello_world = {
  IO::print 'Hello, world!';
};

&io_wrapper console.log, hello_world;

```

## Function Patterns 

If we take [Function Definition Pattern Matching](#function-definition-pattern-matching-fdpm) one step farther, we gain some amazing composition superpowers. 

```silicon
@fn NumberOperation n:number = {
    n * n ^ (Math.sqrt N) / (n!);
};

```

Above we have a contrived example of a simple function that performs some mathematical operation. Let's say that
when the function receives an `n` with a negative value then we return an error. 

```silicon

@fn NumberOperation n:number = {
    @if n < 0 
    @then &Error "value is negative"
    @else n * n ^ (Math.sqrt N) / (n!);
};

```

Now we'll convert that function to use FDPM

```silicon

@fn NumberOperation (n < 0):number = {
    return &Error "value is negative";
};

@fn NumberOperation n:number = {
    n * n ^ (Math.sqrt N) / (n!);
};

```

Splitting it up really keeps the happy path function clean. This also makes testing easier since we do not have
any explicit conditional statements aka branches. 

BUT now that they're separate, we'll show that the first definition that handles negative numbers can be made generic and reusable via composition.

```silicon

## This is our generic function to handle negative numbers
## just a regular function, no magic here
@fn HandleNegativeN (n < 0):number = {
    return &Error "value is negative";
};

@fn NumberOperation n:number = HandleNegativeN;
# alternative syntax
# this would assume 'NumberOperation' is already defined;
# NumberOperation = HandleNegativeN;

@fn NumberOperation n:number = {
    n * n ^ (Math.sqrt N) / (n!);
};


```

As you see, *IF* the function signatures match then we can reuse functions as patterns for other functions. This is like more powerful switch case that can be dynamically modified to handle different cases which are composable. Combined with compile time execution an we can create many
expressive patterns.