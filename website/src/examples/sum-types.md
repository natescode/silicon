---
title: Sum types + @match
---

# Sum types + `@match`

A **sum type** has variants, each marked with `$` and an optional payload.
Payload fields are written `name Type` (no colon):

```silicon
@type Shape := $Circle r Int | $Rect w Int, h Int | $Square s Int;
```

Each variant becomes a constructor function — call it normally:

```silicon
c := Circle(5);
r := Rect(4, 7);
```

`@match` destructures a value, binding the payload fields by name. Each arm is
`pattern => expr`:

```silicon
@use 'io';

@type Shape := $Circle r Int | $Rect w Int, h Int;

\\ longest_side (Shape) -> Int
@fn longest_side s := {
    @match(s,
        $Circle r,  { r },
        $Rect w, h, { w })
};

\\ tag (Shape) -> Int
@fn tag s := {
    @match(s,
        $Circle r,  { 1 },
        $Rect w, h, { 2 })
};

@fn main := {
    print_int(longest_side(Circle(5)));   # 5
    print_int(longest_side(Rect(4, 7)));  # 4
    print_int(tag(Rect(4, 7)));           # 2
    0
};
main();
```

Keep arm bodies simple — bind the payload and return it (or a tag), then do any
arithmetic outside the `@match`. Pattern alternation shares a body across
variants:

```silicon
@enum Color := Red | Green | Blue;

\\ code (Color) -> Int
@fn code c := {
    @match(c,
        Color::Red | Color::Green => 1,
        Color::Blue               => 0)
};
```

`Option[T]` and `Result[T, E]` (in the standard library) are exactly this
machinery — see [Generics](/examples/generics) and
[Error handling with `@try`](/examples/try).

[Reference: HM-lite inference rules for variant constructors →](/reference/hm-lite)
