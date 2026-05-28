---
title: Rc smart pointer
---

# `Rc<T>` — shared ownership

When you need shared ownership but don't want to pay the cost of a real
GC, `Rc<T>` (single-threaded reference count) is in the stdlib:

```silicon
@use 'stdlib/rc.si';

@struct Node value:Int, next:Rc[Node];

@fn main := {
    @let tail:Rc[Node] := &Rc::new (&Node 3, &Rc::nil);
    @let mid:Rc[Node]  := &Rc::new (&Node 2, &Rc::clone &tail);
    @let head:Rc[Node] := &Rc::new (&Node 1, &Rc::clone &mid);
    # head, mid, tail all share ownership of tail
    0
};
```

`&Rc::clone` bumps the refcount; the Rc decrements on drop and frees
the payload when the count reaches zero.

Under `--target=wasm-gc` the Rc identity shim is used (host GC
manages the lifecycle); under the default WAT/QBE targets it's the
bump-allocator implementation. Same Silicon source either way.
