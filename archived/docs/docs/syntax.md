# Silicon Syntax

> "Syntax isn't as important as semantics, except when it is. -- NatesCode"

Ultimately syntax doesn't matter a whole lot. Silicon isn't trying to be revolutionary in that regard. Though Silicon does address some major syntax issue that exist in most C-like language.

Silicon's strives to syntatically be

    1) Familiar
    2) Consistent and Simple
    3) Necessary

## Familiar

This _generally_ means `C` like except where `C` is wrong (see `use [] NOT <> for generics`). This makes adopting `Silicon` much easier. No point in changing something that doesn't have a reason to change. Silicon has C-style comments because why not?

## Consistent

I started with making Silicon's grammar unique because of course it is my own language! Later, I valued consistency which makes it much easier to parse; for human and machines alike.

### Why `@` Keyword Sigil?

The main vestigal syntax remaining in Silicon from `Sillyscript` is the `@` sigil that precedes all keywords. I know `@` isn't easy to type on all keyboards BUT the Silicon LSP allows developers to write `at` instead or simply the keyword `if` and it'll auto-replace / suggest `@if`.

The `@` symbol has 3 main benefits.

1. **Safety / Backwards Compatibility**: additional keywords from updates or third-party packages will NEVER break your code.
2. **Easier Parsing**: Extremely easy to parse Silicon that is mixed with HTML or XML markup languages.
3. **LSP**: `@` makes it easy to get auto-complete and LSP suggestions.

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

### Simpler in PEG

Sigil currently uses a parser generator, `ohm`. Having a simple and consistent grammar backs the PEG definition for `Silicon` much easier. This allow for easier learning, anyone can quickly understand the PEG grammar and learn about the language. It also makes it easier for other compiler / runtime implementations to be made.

## Necessary

Silicon's grammar only differs from C-like languages when certain features make it necessary.

- For example `@let name:string` instead of `string name` syntax makes sense when types are optional. Plus it is much easire to parse, ALL variable declarations start with `@let`. [read here to learn more](https://soc.me/languages/type-annotations)

- Getting rid of `<T>` brackets for generic notation is also a good idea, [read here to learn why](https://soc.me/languages/stop-using-angle-brackets-for-generics.html). `<>` are difficult to parse, especially with HTML / XML! I way use the article's syntax but so far I like `:type:params`

- Silicon has no real `Char` data type, for [good reasons](https://dev.to/awwsmm/why-no-modern-programming-language-should-have-a-character-data-type-51n). Maybe `@grapheme`, `@codepoint` or `@rune` will be added later. Strings do have methods for `width`, `codepoints`, `bytes` etc. String have no concept of `length` because that is semantically ambigous (unless thi string is cast to a typed array of course).

Silicon

```silicon
foo:tuple:(list:string),bool
```

C#

```csharp
Tuple<List<List<string>>>,bool> foo
```

Input before output?

```
@fn add:number a,b =  // ...
@let add:number a,b = // ...
@type add:struct a,b = // ...
```


