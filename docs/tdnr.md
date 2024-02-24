## Type-Directed Name Resolution (TDNR)

There was a [proposal to add TDNR to Haskell](https://web.archive.org/web/20160310052223/https://prime.haskell.org/wiki/TypeDirectedNameResolution). This is _REALLY_ interesting for Silicon because this would really sell the language and set it apart from being too FP or too OOP.

```
@mod int = (
    @fn toString:string value:int;
);

@mod bool = (
    @fn toString:string value:bool;
);

#toString x;
// ERROR: ambigous function call.
// no function overloading.

// fully-qualified name
int::toString x; // correct
bool::toString x; // correct

// Type-Defined Name Resolution
// if X is of type int then it'll resolve to int::toString
// if X is of type bool then it'll resolve to bool::toString
#x.toString;

#5.toString; // "5"
#true.toString; // "true"
```