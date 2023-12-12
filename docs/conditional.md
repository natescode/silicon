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

Silicon only has functions even `when`

```silicon
    @if true, {x = 1},{x = 0};
```

Silicon has a cool syntax, almost like a DSL for function parameters.

```silicon
    @if true
    $then { x = 1 }
    $else { x = 0 };
```

`@if` is a function with three parameters: condition, then_block, else_block.

Here is how If is defined in the compiler.

```silicon
@name if true, then_block, _ = #then_block;
@name if false, _ , null  = #NOP; // if else block isn't defined, no nothing (no op method)
@name if false, _ , else_block = #else_block;
```
