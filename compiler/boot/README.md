# boot/ — the Silicon-in-Silicon bootstrap tree

Per `docs/bootstrap-plan.html`, this directory holds the Silicon source
that will eventually compile itself.  Today it contains only the
**Phase 0** smoke test that proves the WASIX runtime is reachable.

## Layout

```
boot/
├── main.si           # entry program — currently the hello-WASI smoke test
├── std/
│   └── io.si         # thin Silicon wrappers over WASI fd_write / fd_read
└── runtime/          # (empty — populated as later phases land)
```

## Building and running

```bash
bun run boot:build         # compile boot/main.si → boot.wat + boot.wasm
bun run boot:run           # build, then `wasmer run boot.wasm`
```

Or directly:

```bash
bun run scripts/build-boot.ts
wasmer run boot.wasm
```

Expected output:

```
hello, wasix
```

Exit code 0.

## How Phase 0 works

`boot/main.si` is three top-level statements:

```silicon
&write_str 1, 'hello, wasix';
&write_byte 1, 10;
&wasi_snapshot_preview1::proc_exit 0;
```

`write_str` and `write_byte` live in `boot/std/io.si` and wrap the WASI
`fd_write` syscall:

1. Allocate scratch memory for an `iovs` struct (8 bytes: `(ptr, len)`)
   via `&scratch_alloc` from `std.wat`.
2. Store the buffer pointer and length into the iovs.
3. Allocate scratch space for the host to write `nwritten` into
   (out-pointer convention from bootstrap-plan Phase −1.F).
4. Call `&wasi_snapshot_preview1::fd_write fd, iovs, 1, nwritten` —
   lowered to `(import "wasi_snapshot_preview1" "fd_write" ...)`.

Top-level statements land in the generated `$__start` function, which
`--target=wasix` exports as `_start` — the symbol wasmer's WASI runner
invokes automatically.

## Notes

- `'\n'` isn't a valid Silicon string-literal escape (the grammar has no
  escapes today), so newlines go through `write_byte fd, 10`.
- `scratch_alloc` returns a writable address from the heap.  For
  alignment, `write_byte` allocates 4 bytes per call so the next iovs
  buffer stays 4-byte aligned.
- `--target=wasix` also strips `(import "env" "print" …)` and the
  helpers that call it from `std.wat`, so wasmer's WASI host doesn't
  see any unresolved imports.
- The WASI surface is declared once in
  `src/strata/modules/wasi_snapshot_preview1.si`; the loader makes it
  reachable as `&wasi_snapshot_preview1::<name>` and emits the imports
  under the matching env namespace.

## Tests

`tests/wasix-smoke.test.ts` builds boot.wasm and invokes wasmer.  It
skips cleanly when wasmer isn't on PATH.

## Status

- [x] WASIX runtime reachable from Silicon (Phase 0 gate green)
- [ ] Arena allocator implemented in Silicon (Phase 0 stretch)
- [ ] `vec_i32` dynamic array helpers (Phase 0 stretch)
- [ ] Open / read a real file via `path_open` + `fd_read` (next iteration)
