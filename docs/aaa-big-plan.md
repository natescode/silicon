# The Big Silicon Plan


## Compiler Phases

1. Proof-of-Concept in Ohm.js Typescript
2. Production in Zig
3. Bootstrapped in Silicon




## Why Zig (No Crabs?)

Crab language is NOT a perfect fit for my compiler.

- R#st doesn't have seemless C interop. Almost always needed for a compiler
- R#st's memory safety is of little value to a compiler that runs for a period of time then frees all memory at once.
- R#st is much more complex and difficult to bootstrap later. I won't be able to simply port Rust to Silicon, it would be an idiomatic rewrite.
- R#st doesn't have super portable code
- R#st is difficult to refactor with complex lifetimes
- 

Zig language has
- Seemless C interop
- Simple memory model. Allocators are more portable, could make a custom WASM allocator if I wanted.
- Simple limited language features. Much easier to directly port to Silicon later.
- Better cross-compilation and portability
- Fewer abstractions makes refactoring easier 

Also
- Zig produces the smallest WASM binaries
- Faster build times
- Non-toxic foundation / community
- I don't have to dye my hair blue 



Not affiliated, endorsed, nor sponsored by the R#st Foundation