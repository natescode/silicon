# Keywords

<!-- 1. @iden / @name / @let -->
<!-- 1. @when / @if -->

1. @name
1. @when
1. @loop
1. @func
1. @type
1. @impl
1. @next \* replaces 'continue': go to next loop iteration.
1. @fall (fallthrough) \* may not be needed because of pattern matching
1. @exit \* replaces 'break': break from current loop.
1. @give \* replaces 'yield': yield from current block.
1. @quit \* replaces 'return': return from current block.
   // return values get wrapped.

- 'Done' wraps a value while indicating we return a value and are done.
- 'Some' wraps a value while indicating we yield a value and keep going.
- 'None' wraps no value while indicating we keep going.

1. @done \* return 'return': exit current block with optional value.
1. @yeet // non-local return? since Silicon doesn't have throw
1. @dead // throw / panic? kick, konk, ends, croak, term (terminate)
1. @class
1. @value \* replaces `struct`
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
