# Allocators

This feature is inspired by `Zig`.

One change / feature that I'm flushing out for this is environment variable / constructors for modules. For example, in `Zig` a library may ask for a pointer to the user's allocator; dependency injection. That's great but tedious for every,single, library call. I may find semantics to do dependency injection, more or less. As well as do automatic `defer` calls. Likely use a `@local` keyword or something like that, and just require an interface that is more or less like `iDisposable`.

- I think Zig allows this?
