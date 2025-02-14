# Sigils

The toolchain is named `sigil` because Silicon uses a handfull of special characters to add special meaning. Sigils are not operators. They don't _do_ anything other than distinguish the type of identifier or expression. Sigil only come before an identifier (prepended).

There are four sigil characters: `@`,`$`, `&` and `\`. They also have different semantics when doubled.

- `@` keywords.
- `@@` annotations / macros


<!-- // I swapped these. good? -->
- `$` atoms OR named parameters.
- `&` function/block evaluation.
- `&&` compile time function/block evaluation.
- `\` lambda function call 

## Misc

- `_` alone indicated a discard value or implicit value.

## Unused Operators / Symbols

Silicon has 11 Special characters left unused. They _MAY_ be defined according to the specification. If these are defined by an implemenation, they __MUST__ be either binary infix operators or sigils.

`~`
``` ` ```
`"`
`!`
`%`
`^`
`^`
`%`
`?`
`<`
`>`

`<` and `>` are unused and banned since they're used in markup languages such as HTML and XML; builtin functions and methods can be used instead, which imho are more readable.

`&below age, 5` same as `age.below 5`

~~`&if age.below 5 $then 5.00 $else 10.00`~~
`&if age|below 5 $then 5.00 $else 10.00`

```silicon
&@if childs_age | below 7 * years_old
$then &charge 5.00, Currency::dollars 
$else *charge 10.00, Currency::dollars;
 ```

C like
```silicon
if (childs_age < 7 * years_old){
  charge(5.00, Currency.DOLLARS);
}else{
  charge(10.00, Currency.DOLLARS);
}
 ```