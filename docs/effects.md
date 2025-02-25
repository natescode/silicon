# Effects

`Silicon` is heavily inspired by ML languages and functional languages. ~It has a very robust algebraic effects system.~

_Effects_ are part of a secondary type system. They represent side effects that a function may have, such as returning and error, never haulting, 
allocating memory etc. Effects can be thought of like Events or Commands that need to be handled outside of the function.

All Effects have effect handlers. There are default effect handlers for native effects. Users may create custom Effects as well. 

Effects are extremely versatile. Silicon uses algebraic effects to implement numerous language features and patterns: 
  - concurrency
  - error handling
  - events
  - early returns
  - CQRS
  - functional programming
  - 

### Effects Example

Here is a simple hello,world example.

```silicon
# string -> string
@fn greet:string message:string = {
  &@effect IO::print, message;
  @return message;
}

@effect print message:string = {
  &print message;
}
```

The above code takes a message of type string and returns it. It also calls the IO::print effect and
passes the message to it.



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





## Effects

- `total`
- `pure`
- `impure`

---

- `total`
- `exn`
- `div`
- `io`
- `ndet`

`@error` = exception
`@hault` = divergent (never returns / terminates)
`@rands` = random / non-determinitisc
`@inout` = IO

#### Sum types

    @let pure = @error | @hault
    @let total = {}
    @impure = pure | @rands | @inout

`pure` = `exn` + `div`

```
fun sqr    : (int) -> total int       // total: mathematical total function
fun divide : (int,int) -> exn int     // exn: may raise an exception (partial)
fun turing : (tape) -> div int        // div: may not terminate (diverge)
fun print  : (string) -> console ()   // console: may write to the console
fun rand   : () -> ndet int           // ndet: non-deterministic
fun io:    : () -> io                 //   io: all of the above
```