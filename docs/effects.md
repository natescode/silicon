# Effects

`Silicon` is heavily inspired by ML languages and functional languages. It has a very simple but
robust effects system.

_Effects_ are side-effects that a function may have, such as returning and error, never haulting, 
allocating memory etc. 

There are three types of effects in Silicon `total`, `pure` and `impure`. 

## Total

Total is really just `void` for effects. The function does not have any side-effects, haults, throws no errors, is deterministic and doesn't mutate anything. 

```silicon
    /// int -> str
    @fn gt_ten number
        number > 10
    @
```

## Pure

Pure functions do not mutate state, do not use outside state and also return the same
result for the given input (referential transparency).

Pure functions _may_ still return an error i.e. divide by zero, or no hault.

```silicon
// `div 5,0` returns an error
@fn div num,denom
    num / denom
@
```
This is still pure as well

```silicon
// `while true` never haults
@fn while n
    @if n
    @then while n
    @else NONE
@
```

## Impure

The degenerate of effects. Impure functions may no ANYTHING they want.


## COLOR OF EFFECTS

Much like `async` and `await` where a syncronous function may not call an asyncronous function. 

- Total
    - Impure
        -pure

- Total functions cannot call Pure or Impure functions
- Pure functions cannot call Impure functions

__BUT__ this isn't completely true. There are still ways to call these functions actually, thankfully.


```silicon
// number -> total bool
@fn is_gt_ten number
    number > 10
@

// str, text -> pure bool
@fn fs_write filename, data
...code
@

// int, str -> impure maybe bool
@fn write_if_gt_ten number, filename
    @if number.is_gt_ten
    @then @try fs_write filename, "10"
    @else NONE
@

```