# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**Sigil** is a compiler for the **Silicon programming language**, targeting WebAssembly Text Format (WAT). The runtime is **Bun** (not Node.js).

**Status:** Stage 0 (TypeScript). Self-hosting in Silicon is planned per `docs/bootstrap-plan.html`; the in-flight Stage 0 hardening work is in `docs/stage0-cleanup-plan.html`.

## Commands

```bash
bun run src/index.ts       # Compile Silicon source to WAT
bun test                   # Run all tests
bun test src/ast/          # Run tests in a specific module
bun test --watch           # Watch mode
bun run test:properties    # Run property-based tests (60s budget per property)
bun run build-types        # Regenerate grammar type bundles (after .ohm changes)
bun run --watch src/index.ts  # Dev mode with reload
```

Output files after compilation: `ast.json` (annotated AST for debugging), `main.wat` (WebAssembly text).

## Compilation Pipeline

8 sequential stages:

```
Source → Parser → AST → Elaborate → TypeCheck → IR Lower → IR Emit → WAT
```

1. **Parser** (`src/parser/`) — Ohm.js parses source using `src/grammar/silicon-official.ohm`
2. **AST** (`src/ast/`) — `toAst.ts` transforms the Ohm parse tree into typed AST nodes (`astNodes.ts`)
3. **Elaborator** (`src/elaborator/`) — loads `src/strata/*.si`, resolves operators and definition keywords via the strata registry, runs rich strata bodies through the body interpreter (`strataBody.ts`)
4. **TypeChecker** (`src/types/`) — infers and validates types; strict, no implicit coercions; collects all errors before failing
5. **IR Lower** (`src/ir/lower.ts`) — walks the typed AST and lowers to IR nodes (`ir/nodes.ts`); dispatches to the def-expander registry per Definition keyword
6. **IR Emit** (`src/ir/emit.ts`) — prints IR nodes as WAT text; `wasmType` is precomputed on every IR expression
7. **Codegen wrapper** (`src/codegen/`) — inlines `std.wat` runtime into the IR-emitted module; heap starts at offset 1024
8. **Output** — `main.wat` assembled externally with `wat2wasm`

## Where to Look First

- **Language semantics live in `src/strata/*.si`**, not in `lower.ts`. The TypeScript side is mostly the body interpreter (`strataBody.ts`) and IR plumbing (`ir/`, `codegen/`).
- **Operator and keyword lowering** is data-driven: built-ins in `src/strata/operators.si`, `defkinds.si`, `if.si`, `loop.si`, etc.
- **CompilerAPI surface** consumed by strata bodies is documented in `docs/compiler-api.md` and implemented in `src/compiler-api/`.
- **IR kind registry** (`src/ir/irKinds.ts`) maps `IR::*` intrinsic names to `CodegenKind` values that drive def-expander dispatch.

## Adding a Language Feature

The default answer is **add a stratum**, not modify the grammar. Per DEVELOP.md and the bootstrap plan, the grammar is intentionally tiny and stable; new keywords ride the existing `Definition` and `FunctionCall` forms.

To add a Silicon-side feature:
1. Add a stratum entry in `src/strata/*.si` (`@stratum_keyword` or `@stratum_operator`).
2. If the lowering can be expressed with existing `&Compiler::*` calls, write it in the `.si` body — no TypeScript change required.
3. Only if no API surface fits: add a `&Compiler::*` entry to `src/compiler-api/index.ts` and a matching `LowerFns` entry.
4. Add fixtures under `tests/` exercising the new behaviour.

Grammar changes are last-resort and need a discussion first.

## Key Architectural Notes

- **Ohm.js semantic actions** are used in `toAst.ts` (parse tree → AST). The IR layer is plain TS; the legacy `compile.ts` Ohm walk was replaced by the IR pipeline.
- **Elaboration is data-driven:** built-in operators and keywords are defined as Silicon source in `src/strata/*.si`, not hardcoded in the compiler.
- **Type-driven codegen:** every IR expression carries an `inferredType` and a `wasmType`; lowering and emission pick instructions from those, not from substring sniffing of WAT.
- **Strings are UTF-8** with a 4-byte little-endian length header. `$str_concat` in `std.wat` is byte-based; the bootstrap parser will read source bytes via `fd_read` and compare them directly against UTF-8 string literals.
- **`std.wat`** is read from disk at codegen time and inlined into output (no separate linking step).
- **The grammar file (`.ohm`)** is loaded at runtime by Bun, not compiled ahead of time.
- **DO NOT change the grammar.** If it seems necessary, ask permission. Silicon is meant to be simple and bootstrappable. New language features should be added via Stratum.
- **ALWAYS consult the docs** (`docs/bootstrap-plan.html`, `docs/stage0-cleanup-plan.html`, `docs/strata.md`, `docs/compiler-api.md`) for architectural direction.

## Sum Types Today

- `@enum` — payload-free tagged variants, each variant is an immutable i32 global (`Red := 0`, `Green := 1`, …). `@type_sum` is the legacy spelling; both keywords behave identically.
- `@type` (sum-with-payloads / tagged record) — spec only. Requires grammar work; tracked in bootstrap-plan Phase −1.A.
- `@type_alias`, `@type_distinct` — declared and accepted by the typechecker.

## Test Structure

- Unit tests: `*.test.ts` colocated with their module.
- Integration tests: `*.integration.test.ts`.
- End-to-end tests: `src/e2e/`.
- Property tests: `tests/properties/` (run with `bun run test:properties`).
- Single file: `bun test src/types/typechecker.test.ts`.
