# `wit/` — Sigil interface contracts

This directory holds the WebAssembly Interface Type (WIT) definitions that
describe stable cross-language boundaries in the Sigil compiler. Each `.wit`
file is **the single source of truth** for one boundary; the TypeScript
implementations in `src/` and the Silicon `@extern` declarations in
`src/strata/` must conform to it.

## Files

| File | Boundary | Consumers |
|------|----------|-----------|
| `comptime.wit` | Compile-then-run Strata handler imports | `src/comptime/imports.ts` (TS host), `src/strata/<author>/extern.si` (Silicon `@extern`s) |

## Why WIT?

Sigil's comptime engine runs Strata handlers as compiled WebAssembly modules.
Each handler imports host functions (state buckets, IR builders, AST helpers).
Before this directory existed, three places had to be kept in sync manually:

1. The TypeScript implementation in `src/comptime/imports.ts`
2. The `@extern` declarations every handler module needed at the top of its
   `.si` source
3. The prose documentation in `docs/compiler-api.md`

Drift between any two was a class of bug we kept rediscovering — see ADR 0003.

WIT collapses that to one canonical file:

```
                          comptime.wit
                       (source of truth)
                              │
            ┌─────────────────┼─────────────────┐
            ▼                 ▼                 ▼
    TS host bindings   Silicon @externs   prose API docs
   (wit-bindgen --ts)  (sigilc-wit-gen)    (wit-bindgen
                                              --markdown)
```

## Status

| Step | Status |
|------|--------|
| `comptime.wit` reflects the current `imports.ts` surface | ✅ committed |
| TS host generated from `.wit` (wit-bindgen integration) | 🔲 story W-1 |
| Silicon `@extern` declarations generated from `.wit` | 🔲 story W-2 (requires sigilc plugin) |
| `comptime.wit` linted in CI by `wasm-tools component wit` | 🔲 story W-3 |

Until W-1/W-2 land, propagation is manual — but the diff is auditable
against a single file. When you change the host surface:

1. Edit `wit/comptime.wit` first.
2. Mirror the change in `src/comptime/imports.ts`.
3. Mirror in any Silicon handler `.si` files that import the changed function.
4. Add a changeset entry (`npx changeset add`) if the change is observable to
   downstream Strata authors.

## ABI

See the prose comment at the top of `comptime.wit` for the conventions
(`string-id`, `handle`, `ir-handle`, `array-handle`, `0`-is-null). The
short version:

- Every function lowers to all-`i32`-in / `i32`-out (or void).
- IDs and handles are `u32` newtypes.
- Strings cross the boundary as ids into a per-firing `StringPool`.
- Host objects cross as ids into a per-firing `HandleTable`.

This is the legacy ABI; deliberate choice to preserve so today's compiled
handlers keep working. Resource-based redesign tracked in ADR 0007.
