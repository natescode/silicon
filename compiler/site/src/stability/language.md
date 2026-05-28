---
title: Stability — Language
---

# Language stability

The full stability matrix lives in [Stability overview](/stability/). 
This page is a quick reference for the language surface only.

## Stable

- The grammar (`docs/grammar.ebnf`). Changes require a major version bump.
- Built-in keywords currently exposed through `src/strata/*.si`:
  `@if`, `@loop`, `@match`, `@fn`, `@let`, `@var`, `@struct`, `@type`,
  `@enum`, `@type_alias`, `@type_distinct`, `@defer`, `@try`,
  `@return`, `@break`, `@continue`, `@local`, `@export`, `@extern`,
  `@platform`, `@true`, `@false`.
- Operators: `+`, `-`, `*`, `/`, `%`, `==`, `!=`, `<`, `>`, `<=`, `>=`,
  `&&`, `||`, `!`, `&`, `|`, `^`, `<<`, `>>`, `=>`, `|` (in `@match`
  alternation).
- HM-lite inference behavior on `@fn[T]` / `@type[T]`.
- The strata-based extension model — user `@stratum` definitions are
  syntactically identical to built-in ones.

## Unstable

- `@use` path resolution rules. Today the resolver allows absolute and
  relative paths with no project-root jail; this is documented in
  [Security](/stability/security) and is *unstable* — a future hardening
  pass may add a project-root sandbox.
- The `@comptime` execution model. Handlers run on the host process at
  1.0; ADR 0003 pivots this to a Silicon-native interpreter in v1.1.

## Will not be added

These are explicitly out of scope. Adding any would require a major
version bump and a strong design rationale:

- **Postfix operators.** Silicon bans them — `expr?` or `expr!` will
  never parse. See [ADR 0010](/stability/adrs).
- **Integer literal suffixes** (`42i64`, `3.14f`). Use keyword casts
  (`&@toInt64 42`).
- **Implicit type coercion** between integer widths or between integer
  and float.
- **Macros that change the grammar.** All extensibility goes through
  the strata system, which preserves `Definition` / `FunctionCall`
  shape.

## Caveats

- The `wit/comptime.wit` import surface is locked at 1.0; the
  `&Compiler::*` calls reachable from a stratum body are the
  [Compiler API](/reference/compiler-api).
- Strata authors should not call `&Compiler::*` paths not listed as
  *stable* in [Strata API stability](/stability/strata-api). Unknown
  paths warn (rather than error) for graceful degradation on older
  toolchains.
