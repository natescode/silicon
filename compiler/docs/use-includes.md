# `@use` Source Includes

Phase −1.C of `docs/archive/bootstrap-plan.html`. Lets a Silicon source file pull
in other Silicon files at compile time.

## Syntax

```silicon
@use 'helper.si';
@use './lib/strings.si';
@use '/abs/path/to/file.si';
```

- Relative paths resolve from the **including** file's directory (not the
  entry's).
- Absolute paths are honoured as-is.
- The trailing `;` is required (it is the statement terminator the rest of
  the language uses).
- Inside a `#` comment, `@use` is **not** followed: `# @use 'x.si';` is just a
  comment.

## Semantics

Per the bootstrap plan and cleanup plan, the simplest possible rule:

1. **Textual concatenation in dependency order.** Each included file's source
   is emitted before the includer's.  Everything ends up in one global
   namespace as if the user had concatenated by hand.
2. **Cycle detection.** Including A from B and B from A throws a clear
   error showing the cycle.
3. **Deduplication.** The same file referenced multiple times is emitted
   only once (first sighting wins).
4. **No namespacing yet.** Visibility / scoping is deliberately deferred to
   post-Stage-3.  Names from included files appear in the global scope.

## Example

```silicon
# helper.si
@fn add:Int a:Int, b:Int := { a + b };
```

```silicon
# main.si
@use 'helper.si';

@let sum := { &add 1, 2 };
```

Compiling `main.si` produces a WAT module that contains `$add`, `$sum`, and
the top-level `&add 1, 2` call inside `$__start`.

## Implementation

`src/modules/useResolver.ts` is a pre-parse text preprocessor.  It runs
before Ohm sees the source so the grammar stays unchanged (per `CLAUDE.md`).
The CLI (`src/sigil_cli.ts`) calls it before parsing.

Tested by `src/modules/useResolver.test.ts` (unit) and
`src/modules/useResolver.integration.test.ts` (full pipeline).
