# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**Sigil** is a compiler for the **Silicon programming language**, targeting WebAssembly (WAT/WASM) and — via QBE — native binaries. The compiler is written in TypeScript and runs under Bun. Built-in language constructs (operators, control flow, definition kinds) are expressed as Silicon strata under `src/strata/`; the standard library is Silicon source under `src/stdlib/`.

**Status:** The TypeScript compiler in `src/` is the current production compiler. A Silicon-in-Silicon bootstrap previously lived under `boot/`; it has been removed and is slated for a future rewrite. Historical bootstrap plans and superseded design docs are preserved under [`docs/archive/`](docs/archive/) — see that directory's `README.md` for the index. They are kept for traceability but do not describe the current pipeline. The live documentation tree is indexed at [`docs/README.md`](docs/README.md).

## Commands

```sh
bun test                                # run the full test suite
bun test src/types                      # run a directory
bun test src/types/typechecker.test.ts  # run a single file

bun run compile                         # one-shot pipeline driver (src/index.ts)

bun run build:sigilc                    # compile sgl into a native binary at dist/sigilc
```

The `sgl` CLI lives in the sibling `cli/` workspace package (`cli/src/sigil_cli.ts`). Invoke it from source — a globally installed `~/.sgl/bin/sgl` may shadow workspace edits:

```sh
bun run ../cli/src/sigil_cli.ts init my-project
cd my-project
bun run ../../cli/src/sigil_cli.ts run   # compile + execute under wasmtime
```

Tooling assumptions: **Bun ≥ 1.0** for running TypeScript and tests; **wasmtime** for executing compiled WASI binaries; **wat2wasm** (from WABT, or `./bin/wat2wasm` via `scripts/install-wat2wasm.{sh,ps1}`) for `.wat → .wasm` assembly when not going through `binaryen`.

## Compilation Pipeline

The TypeScript compiler walks source through these passes:

```
Source → Parser → AST → Strata loader → Elaborator → Typecheck → IR/Codegen → WAT/WASM (or QBE → native)
```

1. **Parser** (`src/parser/`) — a hand-written, dependency-free recursive-descent parser in `src/parser/handwritten/` (`lexer.ts` + `parser.ts`) producing the typed AST in `src/ast/` directly. There is no separate grammar file; the human-readable grammar spec lives in `docs/grammar.ebnf`.
2. **Strata loader** (`src/elaborator/strataLoader.ts`) — loads built-in `@stratum_*` declarations from `src/strata/*.si` and merges them with user-defined strata.
3. **Elaborator** (`src/elaborator/elaborator.ts`) — resolves operators and definition keywords via the strata registry; rich strata bodies execute through the body interpreter.
4. **Typecheck** (`src/types/typechecker.ts`, `src/types/unify.ts`) — HM-lite inference; pushes structured diagnostics via `src/errors/diagnostic.ts`.
5. **Codegen** (`src/codegen/`) — lowers the typed AST to WAT. `compileToWasm` further assembles WAT into a `.wasm` binary via the `wabt` / `binaryen` deps. The QBE backend (`src/codegen/qbe/`) lowers the same IR for native targets.
6. **CLI** (`../cli/src/sigil_cli.ts`, separate `@silicon/cli` package) — `sgl init/build/run/check` and friends. The public compiler-as-a-service surface lives in `src/caas/`.

## Where to Look First

- **Language semantics live in `src/strata/*.si`**, not in `lower.ts`. These define every operator (`+`, `==`, `<=`, …) and keyword (`@if`, `@loop`, `@var`, …) as data.
- **Operator and keyword lowering** is data-driven: built-ins in `src/strata/operators.si`, `defkinds.si`, `if.si`, `loop.si`, etc. The handful of keywords with TS-side codegen kinds (`function`, `global`, `extern`, …) are dispatched via the def-expander registry in `src/strata/defExpanders.ts`.
- **CompilerAPI surface** consumed by strata bodies is documented in `docs/compiler-api.md` and implemented under `src/compiler-api/`.
- **CaaS (Compiler-as-a-Service) API** — the stable library surface — lives in `src/caas/`. See `docs/compiler-as-a-service.md`.
- **Typechecker** — `src/types/typechecker.ts` is the entrypoint; `src/types/unify.ts` is the HM-lite core. See `docs/hm-lite.md`.
- **Standard library** — Silicon source under `src/stdlib/` (`option.si`, `result.si`, `vec.si`, `hashmap.si`, `slice.si`, `rc.si`, `io.si`).

## Adding a Language Feature

The default answer is **add a stratum**, not modify the grammar. The grammar is intentionally tiny and stable; new keywords ride the existing `Definition` and `FunctionCall` forms.

To add a Silicon-side feature:
1. Add a stratum entry in `src/strata/*.si` (`@stratum_keyword` or `@stratum_operator`).
2. If the lowering can be expressed with existing `Compiler::*` calls, write it in the `.si` body — no further change required.
3. Only if no API surface fits: extend the body interpreter in `src/elaborator/` with a new `Compiler::*` branch.
4. Add a `*.test.ts` exercising the new behaviour and run `bun test`.

Grammar changes are last-resort and need a discussion first.

## Key Architectural Notes

- **Elaboration is data-driven:** built-in operators and keywords are defined as Silicon source in `src/strata/*.si` and loaded into the registry at compile time.
- **Type-driven codegen:** every IR expression carries an `inferredType` and a `wasmType`; lowering and emission pick instructions from those, not from substring sniffing of WAT.
- **Strings are UTF-8** with a 4-byte little-endian length header. `$str_concat` in `src/codegen/std.wat` is byte-based.
- **`std.wat`** is embedded into the compiler at build time (no separate linking step). Heap starts at offset 1024.
- **The grammar is hand-coded** in the recursive-descent parser at `src/parser/handwritten/`. **DO NOT change the grammar** without discussion — Silicon is meant to be simple and bootstrappable; new language features should be added via Stratum.
- **ALWAYS consult the docs** (`docs/strata.md`, `docs/compiler-api.md`, `docs/compiler-as-a-service.md`, `docs/hm-lite.md`) for architectural direction.

## Integer Type Hierarchy

Silicon has three integer surface types, all mapping to WebAssembly value types:

- **`Int`** — target-sized signed integer. On the current `wasm32` target this is `i32`; on a future `wasm64` target it would become `i64`. The default for unsuffixed integer literals.
- **`Int32`** — explicit 32-bit signed integer. Today this is a recognised alias for `Int` (parses to the same `SiliconType`); kept in the surface so code that needs a guaranteed 32-bit type doesn't have to retype when wasm64 lands.
- **`Int64`** — explicit 64-bit signed integer. Always `i64` regardless of target. Required for WASI surfaces with 64-bit fields (`path_open` rights, `fd_seek` offset).

- **`UInt64` / `u64`** — explicit 64-bit unsigned integer. Same `i64` machine representation as `Int64`; the unsigned-ness only changes which instructions arithmetic/comparison dispatch to. Required for WASI fields that are semantically unsigned.

Conversions are explicit — no implicit coercion between widths:

- `@i64(x)` — `Int → Int64`. The human-readable cast; preferred spelling.
- `@u64(x)` — `Int → UInt64`. The human-readable cast; preferred spelling.
- `@toInt64(x)` / `@toU64(x)` — the older WASI-era keyword spellings of the same two casts; still accepted.
- `@toInt(x)` — `Int64 → Int` (wrap; `i32.wrap_i64`). Typed-dispatch overload; the `Float → Int` variant of `@toInt` still applies for `Float` arguments.

A *literal* argument to any i64/u64 cast is **constant-folded** to a direct 64-bit `i64.const`, so literals above the 32-bit range are exact (`@i64(5000000000)` = 5_000_000_000). A *non-literal* argument takes the sign/zero-extend path (`i64.extend_i32_s` / `i64.extend_i32_u`). A literal that overflows the target's 64-bit window is a typecheck error (E0018, IntLiteralOutOfRange).

Arithmetic operators (`+`, `-`, `*`, `/`, `%`) and comparisons (`==`, `!=`, `<`, `>`, `<=`, `>=`) dispatch by operand type via the strata registry. When both operands are `Int64`, the operator resolves to the `i64.*` instruction set. No implicit promotion: `5 + @i64(1)` is a type error — both sides must be the same width.

No integer-literal suffixes — `42i64` does **not** parse (a name-like suffix is hard to read at a glance). Use the keyword cast: `@i64(42)`. Hex / binary / octal literals (`0xFF`, `0b1010`, `0o17`) and `_` digit separators (`5_000_000`, `123_456.789_012`, `0xFF_FF`) are supported in any integer or float literal; the `_`s are stripped when computing the value.

## Sum Types Today

- `@enum` — payload-free tagged variants, each variant is an immutable i32 global (`Red := 0`, `Green := 1`, …). (`@type_sum` was the legacy spelling; it is RETIRED in ADR-0020 — use `@enum`.)
- `@type Shape := $Circle r Int | $Rectangle w Int, h Int;` — sum-with-payloads (types space-separated, no colon). The `$Variant` form marks a variant declarator (data-shape sigil); each variant becomes a constructor function returning the sum type, with pad-to-max record layout `[tag:i32, field0:i32, ..., field<max-1>:i32]` zero-init in unused slots. Pattern destructure in `@match` binds the fields by name.
- `@type Option[T] := $Some value T | $None;` — **parametric** sum types. `Option[Int]` and `Option[Float]` are nominally distinct. Variant constructors are polymorphic: `Some : ∀T. T → Option[T]`. See `docs/hm-lite.md` for how inference handles call sites.
- `@type_alias`, `@type_distinct` — declared and accepted by the typechecker.

## Type Inference

Silicon uses **HM-lite** — Hindley-Milner restricted to declared polymorphism
on `@fn[T]` and `@type[T]`, no let-generalisation. Roc-style trajectory.

- Generic function: `@fn id[T] x T := x;` — call sites infer `T` automatically; no explicit `[Int]` at the call.
- Annotation-driven: a `\\ x Option[Int]` signature line + `x := None()` unifies the body's `Option[?T]` with the annotation.
- Nested inference: `unwrap_or(Some(42), 0)` correctly flows `T = Int` through the chain.

Implementation: `src/types/unify.ts`, `src/types/typechecker.ts`, ~250 lines + 38 unit tests + 33 integration tests. See `docs/hm-lite.md` for the reference.

## `@match` Form

`@match` is an ordinary builtin call: the discriminant, then alternating
pattern / body arguments, each **body a `{ … }` block**. There is no infix arm
operator — `@match` is a "function with parameters," consistent with Silicon's
flat (left-to-right, equal) operator precedence, so an arm body can be any
expression (`{ v * 2 }`, `{ 0 - 1 }`) with zero precedence interaction.

```silicon
# Pattern, then a { } block body — per arm.
@match(opt, $Some v, { v }, $None, { dflt })

@match(sh,
    $Circle r, { r },
    $Square s, { s })

# Per-arm pattern alternation (the `|` stays in the pattern argument):
@match(c,
    $Red | $Green, { 1 },
    $Blue,         { 0 })

# An optional trailing { body } with no pattern is a catch-all default.
```

`normalizeMatchArgs` in `src/ast/matchArms.ts` expands `|` alternation into the
`[disc, pat, body, …]` shape the match lowerer / typechecker consume, and
throws on a leftover `pattern => body` arm (that infix `=>` form was REMOVED —
it collided with flat precedence once a body was itself a binary expression).

## Test Structure

- Tests live alongside the code as `src/**/*.test.ts` and run under Bun: `bun test`.
- Integration tests for the public CLI are in `../cli/src/sigil_cli.test.ts`; end-to-end pipeline tests under `src/e2e/`.
- Property / fuzz suites live under `tests/`: `bun run test:properties`, `bun run test:fuzz`.
- Backend-specific suites: `bun run test:qbe`, `bun run test:backends`, `bun run test:selfhost`.
