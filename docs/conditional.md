# Conditional

Basically `if` in most languages

C if example.

```c
    if(true){
        x = 1
    }else{
        x = 0
    }
```

SI

```si
    x = @when true, { 1 } , { 0 };
    x = @when true, 1, 0;
    @when true, (@fn_ true = { x = 1 } , @fn_ false = { x = 0 })
```

**NEW**

```silicon
    @let x = &@if true, 1, 0;

    @fn if true, then, _= &then;
    @fn if false, _, else = &else;
```

## When

Silicon doesn't have a direct equivalent to `if`. Instead, it has a more powerful and versatile `@when`,
which is closer to `match` in ML languages.

Silicon only has functions even `@when` in just a built-in function.

### IF

Silicon doesn't have an `if` in the traditional sense. It really isn't needed since we have pattern matching with functions.
We can define an anonymous function

    ```silicon
        @fn_ $true = {
            // then
        }
        @fn_ $false = {
            // else
        }
    ```

With potential lambda syntax

    ```silicon
        \$true = {
            // then
        }

        \$false = {
            // else
        }
    ```

The convention is to keep the whole function definition together in parenthesis. The Sigil LSP will give a `warning: function pattern matching definitions aren't grouped together. See [link]()`

    ```silicon
        (\$true = {
            // then
        },
        \$false = {
            // else
        })
    ```

## Idea

// technically a `@when` for pattern matching isn't needed either. With pipe syntax, it is really clean to define an inline function that we pass the data to. `@when` will likely exist but be renamed since effectively it is just `apply`.

Silicon core (the initial)

```
    @loop ,1..30, @fn _,n = {
        (n, n.factorOf(3), n.factorOf(5)) |> (@fn_ n, true, false = {
            #print "fizz"
        })
     }
```

## IF

Silicon has a cool syntax, almost like a DSL for function parameters. Using the atom sigil, `$`.

```silicon
    @if true
    $then { x = 1 }
    $else { x = 0 };
```

You may notice the code is always in `{}`. Silicon is consistent. `{}` denote reusable code blocks. Without them that would just be static code. So unlike ML languages `@func add a,b = a + b` won't work because `a` and `b` refer to parent scope not the block scope. `@func add a,b = { a + b }`. Slightly less verbose.

`@when` is a function with three parameters: condition, then_block, else_block. The else_block is optional of course.

Here is how If is defined in the compiler.

```silicon
@name if true, then_block, _ = #then_block;
@name if false, _ , null  = #NOP; // if else block isn't defined, no nothing (no op method)
@name if false, _ , else_block = #else_block;
```
