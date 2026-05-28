---
title: Arena allocation
---

# Arena allocation

Default `&alloc` bumps the heap. Scoped allocation uses `&with_arena`:

```silicon
@fn process_request input:Slice[u8] := {
    &@with_arena {
        @local tmp:Vec[Int] := &Vec::new;
        @local i:Int := 0;
        &@loop i < (&Slice::len &input), {
            &Vec::push &tmp, (&parse_byte (&Slice::get &input, i));
            i = i + 1;
        };
        &compute &tmp                          # heap pointer reset on scope exit
    }
};
```

All allocations inside the `&with_arena` block live until the block
returns; then the bump pointer is restored. Cheap, predictable, no GC.

## Escaping the arena

To keep a value past the scope, `&move_to_parent_arena`:

```silicon
@fn build_response := {
    &@with_arena {
        @local resp:Response := &Response::new;
        &Response::set_status &resp, 200;
        &move_to_parent_arena &resp           # tail-position escape
    }
};
```

Only flat heap types (and their payloads) can escape — the type system
tracks promotability automatically.

[Reference: Memory + arenas →](/guide/memory)
