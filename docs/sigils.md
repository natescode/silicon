## Sigils

The toolchain is named `sigil` because Silicon uses a handfull of special characters to add special meaning. Sigils are not operators. They don't _do_ anything other than distinguish the type of identifier or expression. Sigil only come before an identifier (prepended).

There are three sigil characters: `@`,`$` and `#`. They also have different semantics when doubled.

- `@` keywords.
- `@@` annotations / macros

- `$` atoms OR named parameters.
- `$$` environment variable.

- `#` function/block evaluation.
- `##` compile time function/block evaluation.

  @if true, {
  "true"
  };

  @fn fib 1 = 1;
  @fn fib 2 = 2;

  @@memo
  @fn fib n = {
  (#fib n - 1) + (#fib n - 2);
  };

  @type bool = @true \\or @false;

## Misc

- `_` alone indicated a discard value or implicit value.
