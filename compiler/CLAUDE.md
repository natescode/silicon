# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**Sigil** is a compiler for the **Silicon programming language**, targeting WebAssembly Text Format (WAT). The compiler is itself written in Silicon — there is no TypeScript, Bun, or Node host. `wasm-bin/stage1.wasm` is the checked-in bootstrap seed; it compiles its own source byte-equal as the self-host gate. The wasm runtime used by every test and by `./build.sh` is **wasmtime** (the WASI reference implementation). Wasmer's WASI compat layer has known bugs at both 2.x (mapped-dir rights) and 7.x (post-`path_open` fd corruption + Windows absolute-path stdout) — wasmtime is the only supported target.

**Status:** Self-hosted.  All seven phases of the bootstrap plan are complete.  **Current work target: `src/` (TypeScript compiler) only — do NOT modify `boot/` Silicon files unless explicitly asked.**  The WASM binary emitter work is being prototyped in `src/codegen/` before being ported to Silicon.

## Commands

```sh
./build.sh                # build wasm-bin/stage1.wasm in place
./build.sh check          # build into a temp + verify byte-equal vs seed
./build.sh test           # build, then announce the runner (test.sh runs it)
./test.sh                 # run the 20 default boot/tests/*_test.si
./test.sh boot/tests/foo_test.si  # run a single test

# Re-emit boot/embedded_bundle.si after editing boot/strata/builtin/*.si
./scripts/regen-embedded-bundle.sh        # bash
.\scripts\regen-embedded-bundle.ps1       # PowerShell

# Compile a user program
wasmtime wasm-bin/stage1.wasm < user.si > user.wat
wasmtime wasm-bin/stage1.wasm --typecheck < user.si > user.wat  # opt-in checker
wasmtime --dir ./src::src wasm-bin/stage1.wasm src/main.si > main.wat  # @use deps
```

PowerShell users substitute `.\build.ps1` for `./build.sh`.  `test.sh` is bash-only today; WSL or Git Bash works on Windows.

## Compilation Pipeline

stage1.wasm walks source through these passes:

```
Source → Parser → AST → Strata loader → Elaborator → [Typecheck] → IR Lower → IR Emit → WAT
```

1. **Parser** (`boot/parser/lex.si` + `boot/parser/parse.si`) — hand-written lexer + recursive-descent parser, builds AST into `P_AST` arena
2. **Strata loader** (`boot/strata/loader.si`) — reads `@stratum_*` declarations from `boot/embedded_bundle.si` into the registry
3. **Elaborator** (`boot/elab/elaborator.si`, `boot/elab/body_rich.si`) — resolves operators + def keywords via the strata registry; runs rich strata bodies through the body interpreter
4. **Typecheck** (`boot/types/check.si`) — opt-in via `--typecheck` flag; infers types and pushes structured diagnostics
5. **IR Lower** (`boot/ir/lower.si`) — walks the elaborated AST and lowers to IR nodes (`boot/ir/nodes.si`); dispatches to def-expanders per Definition keyword
6. **IR Emit** (`boot/emit/wat.si`) — prints IR nodes as WAT text
7. **CLI wrapper** (`boot/cli.si`) — argv parsing, flag dispatch (`--help`, `--typecheck`, `--emit=*`, …), `path_open` for positional source-path arg
8. **Driver** (`boot/stage1.si`) — `_start` glues everything together; reads source from stdin or a positional path, writes WAT to stdout

## Where to Look First

- **Language semantics live in `boot/strata/builtin/*.si`**, not in `lower.si`.  These define every operator (`+`, `==`, `<=`, …) and keyword (`@if`, `@loop`, `@var`, …) as data.
- **Operator and keyword lowering** is data-driven: built-ins in `boot/strata/builtin/operators.si`, `defkinds.si`, `if.si`, `loop.si`, etc.  The handful of keywords with TS-side codegen kinds (`function`, `global`, `extern`, …) are dispatched via the def-expander registry in `boot/ir/lower.si`.
- **CompilerAPI surface** consumed by strata bodies is documented in `docs/compiler-api.md` and implemented in `boot/compiler_api/ctx.si` plus the dispatch in `boot/elab/body_rich.si`.
- **IR kind registry** lives inline in `boot/ir/lower.si`; the IR builders live in `boot/ir/nodes.si`.
- **Typechecker structure** is documented in `docs/phase-2-typechecker-port.md` (briefing for the port that landed); modules are `boot/types/{types,errors,ctx,intrinsic_sig,preregister_std,preregister_defs,check}.si`.

## Adding a Language Feature

The default answer is **add a stratum**, not modify the grammar.  The grammar is intentionally tiny and stable; new keywords ride the existing `Definition` and `FunctionCall` forms.

To add a Silicon-side feature:
1. Add a stratum entry in `boot/strata/builtin/*.si` (`@stratum_keyword` or `@stratum_operator`).
2. If the lowering can be expressed with existing `&Compiler::*` calls, write it in the `.si` body — no further change required.
3. Only if no API surface fits: extend `boot/elab/body_rich.si`'s `Compiler::*` dispatch with a new branch.
4. Regenerate the embedded bundle: `./scripts/regen-embedded-bundle.sh`.
5. Rebuild: `./build.sh`.
6. Add a `boot/tests/<feature>_test.si` exercising the new behaviour, and append it to `test.sh`'s `DEFAULT_TESTS` array.

Grammar changes are last-resort and need a discussion first.

## Key Architectural Notes

- **Elaboration is data-driven:** built-in operators and keywords are defined as Silicon source in `boot/strata/builtin/*.si`, embedded into `stage1.wasm` via `boot/embedded_bundle.si` at build time, and loaded into the registry at compile time.
- **Type-driven codegen:** every IR expression carries an `inferredType` and a `wasmType`; lowering and emission pick instructions from those, not from substring sniffing of WAT.
- **Strings are UTF-8** with a 4-byte little-endian length header.  `$str_concat` in the inlined `std.wat` is byte-based.  The bootstrap parser reads source bytes via `fd_read` and compares them directly against UTF-8 string literals.
- **`std.wat`** is embedded inside stage1.wasm at build time (no separate linking step).  Heap starts at offset 1024.
- **The grammar is hand-coded** in `boot/parser/parse.si`.  There is no separate `.ohm` file in the bootstrap.
- **DO NOT change the grammar.** If it seems necessary, ask permission. Silicon is meant to be simple and bootstrappable. New language features should be added via Stratum.
- **Self-host gate:** `./build.sh check` rebuilds `stage1.wasm` from its own source via the current seed and asserts the new bytes match the seed.  Any change that breaks the fixed point is rejected — the bootstrap stays self-consistent.
- **ALWAYS consult the docs** (`docs/bootstrap-plan.html`, `docs/strata.md`, `docs/compiler-api.md`, `docs/test-bootstrapped-compiler.html`) for architectural direction.

## Integer Type Hierarchy

Silicon has three integer surface types, all mapping to WebAssembly value types:

- **`Int`** — target-sized signed integer.  On the current `wasm32` target this is `i32`; on a future `wasm64` target it would become `i64`.  The default for unsuffixed integer literals.
- **`Int32`** — explicit 32-bit signed integer.  Today this is a recognised alias for `Int` (parses to the same `SiliconType`); kept in the surface so code that needs a guaranteed 32-bit type doesn't have to retype when wasm64 lands.
- **`Int64`** — explicit 64-bit signed integer.  Always `i64` regardless of target.  Required for WASI surfaces with 64-bit fields (`path_open` rights, `fd_seek` offset).

Conversions are explicit — no implicit coercion between widths:

- `&@toInt64 x` — `Int → Int64` (sign-extend; `i64.extend_i32_s`).
- `&@toInt x` — `Int64 → Int` (wrap; `i32.wrap_i64`).  Typed-dispatch overload; the `Float → Int` variant of `@toInt` still applies for `Float` arguments.

Arithmetic operators (`+`, `-`, `*`, `/`, `%`) and comparisons (`==`, `!=`, `<`, `>`, `<=`, `>=`) dispatch by operand type via the strata registry.  When both operands are `Int64`, the operator resolves to the `i64.*` instruction set.  No implicit promotion: `5 + (&@toInt64 1)` is a type error — both sides must be the same width.

No integer-literal suffixes — `42i64` does **not** parse.  Use the keyword cast: `&@toInt64 42`.

Bootstrap support: stage1 understands the full hierarchy via `TYPE_*` constants in `boot/ir/nodes.si` and `type_name_to_kind` in `boot/ir/lower.si`.

## Sum Types Today

- `@enum` — payload-free tagged variants, each variant is an immutable i32 global (`Red := 0`, `Green := 1`, …).  `@type_sum` is the legacy spelling; both keywords behave identically.
- `@type Shape := $Circle r:Int | $Rectangle w:Int, h:Int;` — sum-with-payloads.  The `$Variant` form marks a variant declarator (data-shape sigil); each variant becomes a constructor function returning the sum type, with pad-to-max record layout `[tag:i32, field0:i32, ..., field<max-1>:i32]` zero-init in unused slots.  Pattern destructure in `@match` binds the fields by name.
- `@type Option[T] := $Some value:T | $None;` — **parametric** sum types.  `:Option[Int]` and `:Option[Float]` are nominally distinct.  Variant constructors are polymorphic: `Some : ∀T. T → Option[T]`.  See `docs/hm-lite.md` for how inference handles call sites.  `boot/` does not yet have parametric types — feature is `src/`-only.
- `@type_alias`, `@type_distinct` — declared and accepted by the typechecker.

## Type Inference (`src/` only)

Silicon uses **HM-lite** — Hindley-Milner restricted to declared polymorphism
on `@fn[T]` and `@type[T]`, no let-generalisation.  Roc-style trajectory.

- Generic function: `@fn id[T] x:T := x;` — call sites infer `T` automatically; no explicit `[Int]` at the call.
- Annotation-driven: `:Option[Int] := (&None)` unifies the body's `Option[?T]` with the annotation.
- Nested inference: `(&unwrap_or (&Some 42), 0)` correctly flows `T = Int` through the chain.

Implementation: `src/types/unify.ts`, `src/types/typechecker.ts`, ~250 lines + 38 unit tests + 33 integration tests.  See `docs/hm-lite.md` for the reference.

## `@match` Forms

Both forms are supported and interchangeable:

```silicon
# Legacy flat form
&@match opt, $Some v, { v }, $None, { dflt }

# Arm-expression form (no grammar changes — `=>` and `|` are BinaryOp operators)
&@match opt,
    $Some v => v,
    $None => dflt

# Per-arm pattern alternation
&@match c,
    $Red | $Green => 1,
    $Blue => 0
```

`normalizeMatchArgs` in `src/ast/matchArms.ts` flattens the arm-expression
form into the flat form so the existing match-lowerer / typechecker handle
both uniformly.  Pattern alternation duplicates the body across alternatives.

## Test Structure

- Tests live in `boot/tests/*_test.si`.  Each prints `"<feature> OK"` to stdout on success and exits non-zero on failure.
- `./test.sh` runs the 20 default tests under `wasmtime`.
- Single test: `./test.sh boot/tests/types_test.si`.
- Tests omitted from the default list (`json_test`, `templates_test`, `intrinsics_test`, `elaborator_test`, `strata_loader_test`, `parse_test`, `lex_test`, etc.) compared their output against TypeScript-side dumps that no longer exist; they remain as `.si` files for users who want to drive them under a custom harness.
- See `docs/test-bootstrapped-compiler.html` for a step-by-step testing walkthrough.
