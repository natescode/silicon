---
title: QBE native compile
---

# QBE native compile

Take any Silicon program and add `--release`:

```sh
sgl run --release           # compiles via QBE, runs the native binary
sgl build --release         # writes the binary to ./bin/
```

That's the whole interface. Under the hood:

1. `sgl` lowers your program to the same abstract IR the WAT emitter
   uses.
2. The QBE backend (`src/codegen/qbe/`) maps each abstract op to QBE
   IR text.
3. `qbe` (bundled with `sgl`) compiles QBE IR to native assembly.
4. The host `as` + `ld` assemble and link.

Output: a freestanding binary. No runtime dependency beyond libc.

Tier 1 platforms (CI-tested):

- linux-x86_64
- linux-aarch64
- macos-aarch64 (Apple Silicon)
- macos-x86_64

[Reference: Native compilation guide →](/guide/native)
