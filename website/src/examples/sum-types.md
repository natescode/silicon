---
title: Sum types + @match
---

# Sum types + `@match`

```silicon
@type Shape := $Circle r:Int | $Rect w:Int, h:Int | $Square s:Int;

@fn area s:Shape := {
    &@match s,
        $Circle r => r * r * 3,
        $Rect w h => w * h,
        $Square side => side * side
};

@fn main := {
    @let c:Shape := &$Circle 5;
    @let r:Shape := &$Rect 4, 7;
    @let q:Shape := &$Square 3;
    (&area c) + (&area r) + (&area q)
};

@export main;
```

Each variant becomes a constructor function (`$Circle`, `$Rect`,
`$Square`); pattern destructure binds the fields by name in the arm.

Per-arm alternation is supported:

```silicon
@type Color := $Red | $Green | $Blue;

@fn warm c:Color := {
    &@match c,
        $Red | $Green => @true,
        $Blue => @false
};
```

[Reference: HM-lite inference rules for variant constructors →](/reference/hm-lite)
