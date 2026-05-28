---
title: Generics
---

# Generics + HM-lite inference

```silicon
@fn id[T] x:T := x;

@fn pair[T] a:T, b:T := …;   # returns some Pair[T] you define

@fn main := {
    @let n:Int  := &id 42;        # T = Int  — inferred at call site
    @let s:Str  := &id "hello";   # T = Str  — inferred at call site
    0
};
```

No explicit `[Int]` at the call. Silicon uses HM-lite (Hindley-Milner
restricted to declared polymorphism on `@fn[T]` and `@type[T]`, no
let-generalisation).

Parametric sum types compose naturally:

```silicon
@type Option[T] := $Some value:T | $None;

@fn unwrap_or[T] opt:Option[T], dflt:T := {
    &@match opt, $Some v => v, $None => dflt
};

@fn main := {
    @let x:Int := &unwrap_or (&$Some 42), 0;     # T = Int
    @let y:Str := &unwrap_or (&$Some "yes"), "no"; # T = Str
    0
};
```

The full type-inference reference is at
[/reference/hm-lite](/reference/hm-lite).
