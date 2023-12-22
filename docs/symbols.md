## Syntax / Symbols

- `$` atoms
- `()` group expressions are expression / key-value pairs
- `[]` list of values
- `{}` statements
- `@` keyword
- `` ` backticks for template strings
- `_` unused identifier or anonymous.
  - Sigil for private functions or variables.
  - Digit separated in number literals.
- `;` end of statement or expression
- `.` field access OR namespace access
- `..` range / series operator
- `,` separate values or parameters
- `:` adds optional type name / info to identifiers.
- `/` division
- `//` comment
- `///` multi-line comment (then no \* is needed).
- `=` assignment
- `|` or in Algebraic Data Types
- `|>` pipe (uses `|` and `>`) could use `@pipe` or `=>`
- `*` multiply
- `**` power?
- `+` add
- `++` concat string? `@concat`

Maybe ?

- `==` equality
- `===` identity

## Unused Symbols

1. `~`
1. `!`
1. `%`
1. `^`
1. `&`
1. `\`
1. `?`
1. `|`

Maybe Not

- ~`'T` Generic indentifier~ Use `@any` instead

## Objects / Maps `()`, `=` for assign and `,` separated

    @name Employee = (name = "Nathan Hedglin", tenure = (Days 365), role = $Manager, salary = $165_000.00)

## Arrays `[]` and `,` separated

    @name Fib = [1,3,5,7,9]

## Statements `{}` and `;` separated

    @name ops = {
        1 + 1;
        3 + 4;
    }

## `_`

So far `_` does 3 things is too much.

- `_` throw away
- `_` number separated. This isn't as concerning as `_` for private identifiers. I could change it to `'` since that isn't used anywhere else but that would add a new symbol that is used; a delicate balance. Parenthesis, `()` could be used I suppose kinda like how `""` are used for names with spaces. `(1 000 000)`
- `_private` private. Could be replaced with `@@private` annotation or `@export` the former is preferred.
