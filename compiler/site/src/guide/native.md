---
title: Native compilation
---

# Native compilation via QBE

Silicon's native backend lowers the same IR the WAT emitter uses to
[QBE](https://c9x.me/compile/) IR, then invokes `qbe` + the system
assembler + linker to produce a freestanding executable.

## When to use it

- Shipping a standalone CLI to users who don't have `wasmtime`.
- Faster cold-start than the WASM+wasmtime path.
- Targeting a host that doesn't have a WebAssembly runtime.

For most development you'll use the default WASM path
(`sgl run` / `sgl build`); the native path is a release-time choice.

## Build

```sh
sgl build --release           # alias for --native; emits a native ELF / Mach-O
sgl run --release             # build native, then execute the binary
```

Tier 1 platforms (smoke-tested in CI):

| Platform |
|----------|
| linux-x86_64  |
| linux-aarch64 |
| macos-aarch64 |
| macos-x86_64  |

## What gets bundled

`sgl build --release` produces a single freestanding binary. No
runtime dependency, no shared libraries beyond libc.

The toolchain ships QBE alongside `sgl`; the assembler / linker come
from the host (`as` + `ld` on Linux, the Xcode CLT on macOS). If they're
missing, `sgl` prints a clean error pointing at the missing tool.

## Self-host

The QBE backend is verified by self-host: `dist/sigilc` (the native
`sgl` binary) compiles its own source to a byte-equal WAT module
matching the Bun-compiled `sgl`. See
[`docs/release/release2026-1.md`](/stability/) for the self-host
methodology and the byte-equality checks in CI.

## Cross-target portability

Two layers of portability matter (ADR 0009):

1. **Lifecycle primitives** (`with_arena`, `move_to_parent_arena`,
   `Rc<T>`) — portable across all backends (WAT, QBE, WasmGC).
2. **Introspection / physical-byte primitives** (raw heap byte
   addresses, `size_of` on opaque types) — MVP / native-only. The
   typechecker rejects them under `--target=wasm-gc` with E0012 / E0013.

If you write portable Silicon (the stdlib + most user code), the same
source compiles on every backend.

## Performance

The native backend is faster than WASM + wasmtime for compute-bound
benchmarks; for I/O-bound work the gap is much smaller. See
[Performance →](/stability/performance) for the published 1.0
baseline.

## Caveats

- **No incremental link cache.** Every `sgl build --release` re-runs
  QBE + `as` + `ld` from scratch. Fine for the 1.0 surface; a v1.x
  story if it becomes a bottleneck.
- **Cross-compilation is not supported at 1.0.** Build on the host
  that matches your target.
- **Profile-guided optimisation is not exposed.** QBE doesn't expose
  PGO; that's an upstream concern.
