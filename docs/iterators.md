# Iterators, Coroutines and Concurrency

Silicon will of course have iterators and operations that may be performed on them. I will explain iterators, and common library methods that work with them here, eventually.

Silicon will have much more powerful iterators, called co-routines. Much like co-routines in Lua. Co-routines will likely be in the standard library and not the language itself. Silicon's coroutines are non-preemptive coroutines which means they are not scheduled. Coroutines can yield to a different function that the calling one, there is no parent-child relationship, it is flat.

Silicon is single threaded by default.

`Ruby` has both internal and external iterators. Ruby blocks, like lambdas, can effectively have non-local returns. This means that user code can terminate an internal iterator.

Silicon _might_ allow this but I'm thinking of a different approach.

## Internal iterators

Silicon encourages internal iterators because they are more convenient and less verbose. The main downside in most language is that you can't early return with internal iterators. Silicon DOES allow early returns with a design pattern instead of a keyword (which woould be basically `GOTO`).

```silicon
@name friends = ["Alice","Bob","Charlie","Dave"]

#friends.each @fn _ friend, {
   @when friend,
   @is "bob" = #Done,
   _.width @is 5 = #Some friend,
   _ = #None
};
```

Internal iterators call the given functions and expect a `MaybeIterator` type which is an enum with three options: `Some` that wraps a value and continues the iteration, `None` which indicates we are returning nothing, and `Done` which may wrap a valu and end the iteration.


```silicon
@enum MaybeIterator = {

};
```