# MODES

`Silicon Modes` are how and when Silicon source code is executed.

## Dynamic Silicon

Silicon has a dynamic mode that allows Silicon code to be purely interpreted, not JIT or AOT. It also
allows for dynamic typing, runtime LISP-like macros, varargs etc.

The cool part is that the Silicon interpreter, `Sigil -dyn`, is written in Silicon. So there is no need to translate dynamic Silicon objects to compiled Silicon object.

This mode allows cool things like multiple dispatch.

// One function definiton per arity. If types change then use typeclasses / generics.

## Static

Typeclasses / Traits. Basically a pointer to a vtable that can be updated to add methods after the fact.

### Typeclasses / Traits,

Not sure about syntax for it yet.

```silicon

    @type stringy:@interface 'Type = {
        @fn to_string:string a:Type
    }

    // @impl, @def, @implement, @fullfill
    @type stringy:@impl int = {
        @fn to_string:string a:int = {
            // ...code...
        }
    }

```

UFCS, they aren't really methods. No dispatch.

```silicon
add a,b,c

a.add b,c

(a,b).add c
```

## Typed

## Safe
