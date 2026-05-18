# boot/ — the Silicon-in-Silicon bootstrap tree

Per `docs/bootstrap-plan.html`, this directory holds the Silicon source
that will eventually compile itself.  Today it contains only the
**Phase 0** smoke test that proves the WASIX runtime is reachable.

## Layout

```
boot/
├── main.si             # stdin → stdout echo (Phase 0 gate)
├── std/
│   ├── io.si           # WASI fd_write / fd_read wrappers
│   ├── arena.si        # bump-pointer allocator with reset
│   └── vec.si          # vec_i32 dynamic array
├── tests/
│   ├── arena_test.si   # alloc / alloc / reset / alloc → same addr
│   └── vec_test.si     # push 10 → grow twice → sum is 45
└── runtime/            # (empty — populated as later phases land)
```

## Building and running

```bash
bun run boot:build                    # compile boot/main.si → wasm-bin/boot.{wat,wasm}
bun run boot:run                      # build, then `wasmtime wasm-bin/boot.wasm`
wasmtime wasm-bin/boot.wasm < some-file.txt    # echo a file's contents to stdout
```

The echo program reads stdin in 4 KiB chunks and writes them back to stdout
until EOF, then exits with status 0.  Verified byte-exact on `README.md`.

To run a different entry (e.g. one of the unit tests):

```bash
bun run scripts/build-boot.ts boot/tests/arena_test.si
wasmtime wasm-bin/boot.wasm
# → arena OK
```

## How Phase 0 works

`boot/main.si` defines an echo loop that calls into `boot/std/io.si`:

```silicon
@fn echo_stdin := {
  @local BUF_SIZE := 4096;
  @local buf      := &arena_alloc BUF_SIZE;

  &@loop 1, {
    @local mark := &arena_save;
    @local n    := &read_bytes 0, buf, BUF_SIZE;
    &@if (n <= 0), { &@break };
    &write_bytes 1, buf, n;
    &arena_reset mark;
  };

  &wasi_snapshot_preview1::proc_exit 0;
};

&echo_stdin;
```

`read_bytes` / `write_bytes` build an iovs struct in scratch memory and
call `fd_read` / `fd_write` from the `wasi_snapshot_preview1` module.
`arena_save` / `arena_reset` rewind the bump pointer each iteration so
the scratch iovs don't accumulate.

Top-level `&echo_stdin` lands in `$__start`, which `--target=wasix`
exports as `_start` — the symbol the WASI runner (wasmtime, wasmer, …)
invokes automatically.

## Notes

- `'\n'` isn't a valid Silicon string-literal escape (the grammar has no
  escapes today), so newlines go through `write_byte fd, 10`.
- `scratch_alloc` returns a writable address from the heap.  For
  alignment, `write_byte` allocates 4 bytes per call so the next iovs
  buffer stays 4-byte aligned.
- `--target=wasix` also strips `(import "env" "print" …)` and the
  helpers that call it from `std.wat`, so the WASI host doesn't see
  any unresolved imports.
- The WASI surface is declared once in
  `src/strata/modules/wasi_snapshot_preview1.si`; the loader makes it
  reachable as `&wasi_snapshot_preview1::<name>` and emits the imports
  under the matching env namespace.
- `@let x := expr` at top level becomes a *function* `$x`, not a one-shot
  binding evaluated at module init.  To get eager local bindings, wrap
  the body in an `@fn` and invoke it from `$__start`.

## Known limitations (next iteration)

- **No boolean short-circuit `&&` operator.**  The `&` sigil is reserved
  for function calls, so the keyword form `&@and a, b` does the work.
  `||` is an operator and works as expected.

## Tests

`tests/wasix-smoke.test.ts` builds boot.wasm and invokes wasmtime for
the echo program plus the arena and vec unit tests.  It skips cleanly
when wasmtime isn't on PATH.

## Status

- [x] WASI runtime reachable from Silicon
- [x] Arena allocator with save/reset (`boot/std/arena.si`)
- [x] `vec_i32` dynamic array with grow-by-doubling (`boot/std/vec.si`)
- [x] File-echo gate: `wasmtime wasm-bin/boot.wasm < README.md` reproduces
      README.md byte-for-byte on stdout, exits 0
- [x] argv-based file open via `path_open` (Silicon-Core i64 +
      `boot/std/fs.si`; see `boot/cli.si` for the dispatcher)
