# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**Sigil** is a compiler for the **Silicon programming language**, targeting WebAssembly Text Format (WAT). The runtime is **Bun** (not Node.js).

## Commands

```bash
bun run src/index.ts       # Compile Silicon source to WAT
bun test                   # Run all tests
bun test src/ast/          # Run tests in a specific module
bun test --watch           # Watch mode
bun run build-types        # Regenerate grammar type bundles (after .ohm changes)
bun run --watch src/index.ts  # Dev mode with reload
```

Output files after compilation: `ast.json` (annotated AST for debugging), `main.wat` (WebAssembly text).

## Compilation Pipeline

6 sequential stages, each independent:

```
Source → Parser → AST → Elaborator → TypeChecker → Codegen → WAT
```

1. **Parser** (`src/parser/`) — Ohm.js parses source using `src/grammar/silicon-official.ohm`
2. **AST** (`src/ast/`) — `toAst.ts` transforms the Ohm parse tree into typed AST nodes (`astNodes.ts`)
3. **Elaborator** (`src/elaborator/`) — resolves operators via `@stratum` definitions, maps them to WASM intrinsics (e.g., `+` → `i32_add`); registry rebuilt per compilation
4. **TypeChecker** (`src/types/`) — infers and validates types; strict, no implicit coercions; collects all errors before failing
5. **Codegen** (`src/codegen/`) — walks AST, emits WAT; inlines `std.wat` runtime; heap starts at offset 1024
6. **Output** — `main.wat` assembled externally with `wat2wasm`

## Adding a Language Feature

Per DEVELOP.md:
1. Add grammar rule to `src/grammar/silicon-official.ohm`
2. Add AST node types to `src/ast/astNodes.ts`
3. Add semantic actions in `src/ast/toAst.ts` (Ohm semantic actions pattern)
4. Add codegen in `src/codegen/compile.ts`
5. Run `bun run build-types` if grammar changed

## Key Architectural Notes

- **Ohm.js semantic actions** are used in both `toAst.ts` (parse tree → AST) and `compile.ts` (AST → WAT) — the same pattern appears in both
- **Elaboration** is data-driven: builtin operators are defined as Silicon source in `src/elaborator/builtins.ts`, not hardcoded in the compiler
- **Type inference in codegen** currently sniffs for `f32.const` to pick i32 vs f32 ops — a known temporary approach
- **`std.wat`** is read from disk at codegen time and inlined into output (no separate linking step)
- The grammar file (`.ohm`) is loaded at runtime by Bun, not compiled ahead of time
- **DO NOT** change the grammar. If it seems necessary, ask permission. Silicon is meant to be simple and bootstrappable. New language features should be added via Stratum. 
- **ALWAYS** consult the docs for help on architectural direction.

## Test Structure

Each module has `*.test.ts` (unit) and some have `*.integration.test.ts`. End-to-end tests live in `src/e2e/`. To run a single test file: `bun test src/types/typechecker.test.ts`.
