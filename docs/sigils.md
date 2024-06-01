# Sigils

The toolchain is named `sigil` because Silicon uses a handfull of special characters to add special meaning. Sigils are not operators. They don't _do_ anything other than distinguish the type of identifier or expression. Sigil only come before an identifier (prepended).

There are four sigil characters: `@`,`$`, `&` and `\`. They also have different semantics when doubled.

- `@` keywords.
- `@@` annotations / macros


<!-- // I swapped these. good? -->
- `$` atoms OR environment variable.
- `$$` named parameters.

- `&` function/block evaluation.
- `&&` compile time function/block evaluation.

- `\` infix function call

```silicon
 if true, 'yes';

  @fn fib 1 = 1;
  @fn fib 2 = 2;

  @@memo
  @fn fib n = {
    (&fib n - 1) + (&fib n - 2);
  };

  @type bool = $true \or $false;
```

## Misc

- `_` alone indicated a discard value or implicit value.

## Unused Operators / Symbols

Silicon leave ~~10~~ 12 Special characters left unused. They _MAY_ be defined according to the specification. If these are defined by an implemenation, they __MUST__ be either binary infix operators or sigils.

`~`
``` ` ```
`"`
`!`
`%`
`^`
`|`
`^`
`%`
`?`
`<`
`>`


`<` and `>` are unused since they're used in markup languages such as HTML and XML; builtin functions and methods can be used instead, which incidently are more readable.

`&below age, 5` same as `age.below 5`

`&if age.below 5 $then 5.00 $else 10.00`


keywords are all caps? Make it like SQL + PYTHON

```silicon
IF childs_age IS BELOW 7 years_old
THEN charge 5.00 dollars 
ELSE charge 10.00 dollars
 ```

C like
```silicon
const int years_old = 1;
if (childs_age < 7 * years_old){
  charge(5.00, Currency.DOLLARS);
}else{
  charge(10.00, Currency.DOLLARS);
}
 ```