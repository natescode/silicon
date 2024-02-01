## FUNCTIONS

Parenthesis and types are optional. The function is the main abstraction in Silicon. Due to this, function have a few superpowers.

## Parenthesis

Silicon grammar doesn't use parethesis for anything but grouping expression.

## Types

ALL types in Silicon are inferred. They can be optionally included after the identifier with `:type` syntax.

## Implicit returns

Silicon has implicit returns. `Rust` is a modern example of this. You can still use the `@exit` keyword for explicit returns.

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

Generally, this doesn't happen and removing parens in much easier to read. The Si LSP will warn about ambigous expressions like this.

## Function Definition Pattern Matching (FDPM)

Function Definition Pattern Matching means function parameters can be defined with values. Basically mapping inputs to pre-defined outputs. We can
implement an if expression to work with booleans this way.

```silicon
// ? means else is optional
@fn if true, then, else? = { #then; };
@fn if false, then, else? = { #else; };

// default parameters? Can't use '='. Use ';'?
// @fn if bool, then, else=null; =  { }

#if true, { #print "I'm working"; }, {#print "Not functioning";};
```

## Named Parameters

In the last example we defined a simple 'if' function. We can make 'if' work with more of a DSL by using
Silicon's named parameter syntax. `$` Sigil defines atoms which are named parameters or types that have only one value, themselves i.e. `$true`.

We could call `if` with named parameters instead. They then act like keywords. I may default these parameters to be inside `{}` implicitly since normally
just passing in code mean it runs immediately and it isn't a block.

```silicon
#if true
$then #print "I'm working"
$else #print "Not functioning"
```

## Unified Function Call Syntax (UFCS)

Unified Function Call Syntax. This means that function may be called like methods without any modification. The first parameter because the reciever.

Let's define a simple function that coverts a boolean value to a string.

```silicon
@fn boolToString bool = {
  #if bool
  $then "true"
  $else "false"
};

```

Let's call it as a function then as a method.

```silicon
// function
#boolToString true // "true"

// method
#true.boolToString // "true"
```

## Type Defined Name Resolution

This is explained elsewhere but it is related to functions / methods. Silicon doesn't allow function/method overloading (Silicon dynamic does).
This may feel limiting, it is. So Silicon tries to make it a little better by fixing some cases.

Before defined our `boolToString` function/method before but it has to have its own unique name. We couldn't make it just `ToString` like
we could if we had function/method overloading. We can simulate this with TDNR by allowing the type of the method reciever to dictate which module we use.

For example

```silicon
@module bool = {
    @fn ToString bool = {
        #if bool
        $then "true"
        $else "false"
    };
};
```

We can then use this function with its full name

```silicon
    #bool::ToString true // "true"
```

We could possibly run into an ambigous function call error if we used UFCS though.

```silicon
    @let foo = true;
    #foo.ToString // Error: 'ToString' function is amibgous. 'bool::ToString', 'number::ToString'...
```

This can be fixed if Silicon looks at the type of the method receiver, `foo` in this case, and uses that information
to look inside the correct module (namespace).

```silicon
    @let foo = true;
    @let bar = 10;

    // calls Boolean::ToString
    #foo.ToString // "true"

    // calls Number::ToString
    #bar.ToString // "10"
```

So this makes the lack of proper function overloading a bit less painful. Again, if we _really_ need true function overloading we could
use Silicon's dynamic dialect.

```silicon
@@dynamic {
    @fn ToString bool:boolean = {};
    @fn ToString Number:number = {};

    @let x = true;
    #x.ToString; // "true"
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

I could just wrap parameters in `()` to be more consistent. Or drop the `=` of course. or use `;`.

```silicon
    @fn foo (x,y = 3) = {};
    @fn foo x,y = 3 {};
    @fn foo x,y = 3; = {};
```
