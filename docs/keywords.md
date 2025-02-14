# Keywords

1. @name or @var 
1. @when 
1. @loop 
1. @fn
1. @type
1. @impl
1. @next \* replaces 'continue': go to next loop iteration.
1. @fall (fallthrough) \* may not be needed because of pattern matching
1. @break \* replaces 'break': break from current loop.
1. @yield \* replaces 'yield': yield from current block.
1. @return \* replaces 'return': return from current block.

- 'Done' wraps a value while indicating we return a value and are done.
- 'Some' wraps a value while indicating we yield a value and keep going.
- 'None' wraps no value while indicating we keep going.

1. @return
1. @panic 
1. @class
1. @struct / @record  / @value
1. @trait
1. @union
1. @alias

#### Module keywords

1. @pkg \\ Package (project)
1. @mod \\ Module (folder)
1. @cmp \\ Component (file)
1. @import
1. @export

## Named Operators

- @and &&
- @or ||
- @not !
- @least >=
- @most <=
- @above >
- @below <
- @between start < x < end `@x @is @between 3 @and 5` . `@x @between 3..5`
- @within start <= x <= end
- @outside x < val < x

## Annotations

- @@co // TODO: coroutines. \* may be a std library function
- @@mut // TODO: mutability keywords?
- @@imm // TODO: mutability keywords?
- @@defer // TODO: implement
- @select //TODO: coroutine select in std library

## Execution time annotation

- @@compile (execute at compile time)
- @@execute (compile and execute at runtime)
- @@analyze (interpret and execute at runtime)


## Keywords vs Builtins

Keywords start with the `@` sigil. _builtin_ functions like `if` come from the `si` namespace.

**EXAMPLE**

```silicon
@let age:u32 = 0x21;

&si::if age \at_least 18 \and hasPaid $then 'welcome!' $else 'halt!!!';

if age >= 18 && hasPaid
```