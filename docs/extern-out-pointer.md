# `@extern` Out-Pointer Calling Convention

A documentation-only addition for Phase −1.F of `docs/archive/bootstrap-plan.html`.
This is the convention the bootstrap compiler will use to talk to WASI / WASIX
syscalls that return more than a single i32.

## The Problem

`@extern` declares a single result type:

```silicon
\\ @extern wasi_proc_exit (Int) -> Void    # void return
\\ @extern get_arg_count () -> Int         # single i32 return
```

But WASI syscalls like `path_open` return an *errno* and write their actual
result (the new file descriptor) into a buffer the caller supplies:

```c
__wasi_errno_t __wasi_path_open(
    __wasi_fd_t            fd,
    __wasi_lookupflags_t   dirflags,
    const char *           path,
    size_t                 path_len,
    __wasi_oflags_t        oflags,
    __wasi_rights_t        fs_rights_base,
    __wasi_rights_t        fs_rights_inheriting,
    __wasi_fdflags_t       fdflags,
    __wasi_fd_t *          opened_fd  /* host writes here */
);
```

A Silicon side `@extern` can't express the `*opened_fd` out-pointer in its
result type, but it doesn't need to: WebAssembly passes pointers as i32
arguments, so the out-parameter rides the input arg list.

## The Convention

1. **Declare the extern with an extra `Int` arg per out-pointer.**  Document
   in a comment which arg is the out-pointer.
2. **Allocate scratch space with `scratch_alloc(n)`.**  The helper is
   exported by `std.wat` and returns a writable i32 address.
3. **Read the result back with `WASM::i32_load(address)`**, or with a
   per-type variant (`i32_load8_u`, `f32_load`, …).
4. **Lifetime:** scratch addresses live until the next `arena_reset`.
   Stage 0 has no reset hook (one-shot compile); Stage 1 will reset between
   compile passes.

## Example: `path_open`

```silicon
# out-pointer (last arg): host writes the new fd there
\\ @extern wasi_path_open (Int, Int, Int, Int, Int, Int, Int, Int, Int) -> Int;

\\ openFile (Int, Int) -> Int
@fn openFile path_ptr, path_len := {
  fd_out := scratch_alloc(4);
  wasi_path_open(
    3, 0, path_ptr, path_len,    # dirfd=3 (first preopen), flags=0
    0, 0xFFFFFFFF, 0xFFFFFFFF, 0,
    fd_out);
  WASM::i32_load(fd_out)         # the fd the host wrote
};
```

## Why Not Multi-Return

WASM 2.0 multi-value works in principle, but:

- Stage 0's IR encodes `@extern` results as a single optional type
  (`src/modules/loader.ts`).
- The bootstrap is small enough that one address-per-out-parameter is
  cheaper than threading multi-value through every layer.
- WASIX itself returns errno on the stack and writes results through
  out-pointers, so this convention matches the underlying syscall API
  directly.

Multi-return is on the post-Stage-3 wishlist; for the bootstrap, this
convention is the supported path.

## Verification

The conventions are tested in `tests/properties/extern-outptr.property.test.ts`.
The end-to-end "host actually wrote through the pointer" check belongs in
Phase 0 of the bootstrap plan (WASIX smoke test); at compile time we only
assert the plumbing is correct.
