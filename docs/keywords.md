# Keywords

1. @iden / @name / @let
1. @when / @if
1. @loop
1. @type
1. @impl
1. @skip (alternative to continue)
1. @fall (fallthrough) \* may not be needed because of pattern matching
1. @exit \* replaces 'break': return from current loop.
1. @give \* replaces 'yield': yield from current block.
1. @quit \* replaces 'break': exit current block.
   // return values get wrapped.

- 'Done' wraps a value while indicating we return a value and are done.
- 'Some' wraps a value while indicating we yield a value and keep going.
- 'None' wraps no value while indicating we keep going.

1. @done \* return 'return': exit current block with optional value.
1. @yeet // non-local return? since Silicon doesn't have throw
1. @dead // throw / panic? kick, konk, ends, croak, term (terminate)
1. @class
1. @value / @struct
1. @trait / @interface
1. @package
1. @module
1. @component
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
- @between start < x < end
- @within start <= x <= end
- @outside x < val < x

## Annotations

- @@co // TODO: coroutines. \* may be a std library function
- @@mut // TODO: mutability keywords?
- @@imm // TODO: mutability keywords?
- @@wait (defer) // TODO: implement
- @select //TODO: coroutine select in std library

## Execution time annotation

- @@compile (execute at compile time)
- @@execute (compile and execute at runtime)
- @@analyze (interpret and execute at runtime)

// OLD

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
