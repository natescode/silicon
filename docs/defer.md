# Defer

I generally like the `defer` keyword in languages like `Zig` and `Odin`. Not as much in `Go` as it does some magical and dangerous things.

Silicon has `@local` that is similar to `defer` but closer to `C#'s` `Using` keyword. 

Types can implement the `free` interface and then `@local` just works.

See how Zig works.

```zig
    var list = std.ArrayList(i32).init(std.testing.allocator);
    defer list.deinit(); 
```


Instead, types can register a `free` method.

```silicon
@let list = &si::ArrayList i32;
@@free list;
```

Or in one line with `@local` which means it is in local scope and cleaned up automatically.

```silicon
@local list = &si::ArrayList i32;
```

Basically `ArrayList` has a function semantically tagged as `free`.

```silicon
@@export
@type ArrayList = {
    # ... code
}

@@conforms_to si::mem::Free
@fn deinit self:ArrayList = {
    # ... code ...
}
```