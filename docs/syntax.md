# Silicon Syntax

> "Syntax isn't as important as semantics, except when it is. -- NatesCode"

Ultimately syntax doesn't matter a whole lot. Silicon isn't trying to be revolutionary in that regard.

Silicon's goals with syntax are

    1) Familiar
    2) Consistent and Simple
    3) Necessary

## Familiar

This _generally_ means `C` like except where `C` is wrong (see `use [] NOT <> for generics`). This makes adopting `Silicon` much easier. No point in changing something that doesn't have a reason to change. Silicon has C-style comment because, why not?

## Consistent

I started with making Silicon's grammar unique because of course it is my own language! Later, I valued consistency which makes it much easier to parse; for human and machines alike.

### Why `@` Keyword Sigil?

The main vestigal syntax remaining in Silicon from `Sillyscript` is the `@` sigil that precedes all keywords. I know `@` isn't easy to type on all keyboards BUT the Silicon LSP allows developers to write `at` instead or simply the keyword `if` and it'll auto-replace / suggest `@if`.

The `@` symbol has 3 main benefits.

1. Safety / Backwards Compatibility: additional keywords will NEVER break your code.
2. Parsing: Extremely easy to parse Silicon that is mixed with HTML or XML markup languages.
3. LSP: `@` makes it easy to get auto-complete and LSP suggestions.

Parsing speed does matter. Most compilers spend 70%+ of their time in the front-end (parsing, lexing, tokenizing etc). Languages like `Rust` and `C++` are so syntatically complex that formatting them can change the semantics of the program and they require arbitary / infinite lookahead to just parse, yuck!

This means that all definitions will have a `=` assignment operation at some point. All function calls / expression evaluations start with `#` or `##` (`@comptime` calls.)

## DEF grammar

ALL definition have the same grammar

    KEYWORD IDENTIFIER PARAMS =

Identifiers can have `:type:type_param` after as well.

## EXE grammar

ALL function call / evals are the same grammar as well

    #add 1,2 // 3

OR

    #{1 + 2} // 3

## Necessary

- For example `identifier type` instead of `type indentifier` syntax makes sense when types are optional.

- Getting rid of `<T>` brackets for generic notation is also a good idea, [read here to learn why](https://soc.me/languages/stop-using-angle-brackets-for-generics.html).

- Silicon has no real `Char` data type, for [good reasons](https://dev.to/awwsmm/why-no-modern-programming-language-should-have-a-character-data-type-51n). Maybe `@grapheme`, `@codepoint` or `@rune` will be added later.
