# Silicon Syntax

21 September, 2023

\*Note

Silicon's syntax has changed a lot over time. I've decided to stick to a C-like syntax that is simpler but also VERY consistent.

## Two grammars

Silicon has two main grammar rules: `definition` and `execution` aka `def` and `exe`, respectively.

### DEF grammar `@` and `=`

`@` precedes all keywords: built-in Silicon constructs. USER defined grammar of course are allowed. A name for the thing you're defining.

- variables
- types
- functions

```typescript
// GRAMMAR
@let name = "Silicon"
@let list:int = [1,2,3]
@fn ten = 10
@fn add a, b = { a + b }
@type person = { age: int }
$custom_def iden = // ... code ...
```

### EXE grammar `#` or `@`

Grammar for function calls and expressions to evaluate.
Once we've defined something. Let's use it!

- functions
- code blocks / quoted macros
- expressions

```silicon
#add 1,2
#person{age:45}
@if condition, then_block, else_block
```

## Keywords and Sigils

Silicon uses a few sigils, hence the name for the toolchain. Sigils are just little symbols with special meaning.

`@` - Precedes ALL built-in Silicon keywords

`@@` - for special syntax / language extensions

`$` - Precedes ALL atoms. Atoms are types with a single value.

`#` - Precedes ALL run-time code that should be evaluated. `#{}` for a runtime code block.

`##` - Precedes ALL compile-time code that should be evalutaed. `##{}` for a comptime block

`_` - precedes ALL private data. // Maybe?

`<-` or `&` - derefence pointer

`->` - pointer

## References & Pointers

Silicon doesn't expose raw pointers, generally. The
most common usage for passing something by reference is functions. Since functions call syntax doesn't use `()` then this may seem ambiguous. Instead of passing the reference to the function, we can pass the _code_ of the function to be called later. We use _quote_ macros.

Example:

`pass_callback` is a function that we pass another function to. `callback` is the function. Instead of having `callback()` and `callback` to differentiate execution and passing by reference. We can just use back ticks. Any code in backticks is basically a script that can be executed later. Sigil, Silicon's compiler, is intelligent and can make this just a refernce if we just pass a function and aren't doing any macro magic with the source code.

```
// using quotes
pass_callback `callback param`

// using reference
pass_callback @ref callback param
```

## Generics

Example in C#

```csharp
List<int> a = new List()
```

Example in Silicon

```ml
@let a:List:int = list::new
```

So this in C#

```csharp
Tuple<List<int>, bool> foo;
```

Equals this in Silicon

```silicon
@let foo :Tuple:(List:int),bool
```

##### overloading vs traits / interfaces

```c#
public int add(int a, int b){
    return a + b;
}
// add_int_int_int
// add_int_int_int_int

public int add(int a, int b, int c){
    return a + b + C;
}

add(1,2) // 3
add(1,2,3) // 6

```

Interface

```c#
public static class IntExtension
{
    public static int add(this int number, int a, int b)
    {
        return number + a + b
    }
}
```

```
interface iadd {

}

```
