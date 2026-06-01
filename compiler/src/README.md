# Silicon Compiler Source Code

This directory contains the source code for the Silicon compiler.

## Structure

```
src/
├── index.ts              # Entry point - orchestrates the compilation pipeline
│
├── parser/               # Stage 1: Parsing (source code → typed AST)
│   ├── index.ts          # Module exports
│   ├── parser.ts         # Parse entry point — calls parseToAst()
│   └── handwritten/      # Hand-written recursive-descent parser (lexer.ts + parser.ts)
│
├── ast/                  # Stage 2: AST Construction (parse tree → AST)
│   ├── index.ts          # Module exports
│   ├── astNodes.ts       # Type definitions
│   └── toAst.ts          # Transformation logic
│
├── codegen/              # Stage 3: Code Generation (AST → WAT)
│   ├── index.ts          # Module exports
│   ├── compile.ts        # Code generation
│   └── std.wat           # Standard library
│
└── grammar/              # Legacy compatibility shims
    ├── index.ts          # Module exports
    └── SiliconGrammar.ts # Inert sentinel kept so old call sites resolve
```

The grammar is implemented directly in the hand-written parser under
`parser/handwritten/`. The human-readable grammar spec lives in
`docs/grammar.ebnf`; there is no separate grammar file.

## Quick Reference

### Main Entry Point

- **index.ts** - Start here. Shows the full pipeline: parse → AST → codegen

### The Three Compilation Stages

1. **Parser** (`parser/parser.ts`)
   - Input: Source code (string)
   - Output: The typed AST `Program` directly
   - `parse()` calls `parseToAst(src)` in the hand-written recursive-descent
     parser under `parser/handwritten/`

2. **AST** (`ast/`)
   - Strongly-typed AST node definitions
   - `astNodes.ts`: Type definitions
   - `toAst.ts`: thin identity shim (the parser builds the AST directly)

3. **Codegen** (`codegen/compile.ts`)
   - Input: AST
   - Output: WebAssembly (WAT format)
   - `std.wat`: Standard library functions

### Grammar

- **docs/grammar.ebnf** - Formal grammar specification (human-readable)
- **parser/handwritten/** - The hand-written parser that implements it
- **SiliconGrammar.ts** - Inert sentinel, kept only so old call sites resolve

## Making Changes

See the appropriate guide:

- **New feature?** → [DEVELOP.md](../DEVELOP.md) → "Adding a New Language Feature"
- **Contributing?** → [CONTRIBUTE.md](../CONTRIBUTE.md)
- **Understanding architecture?** → [ARCHITECTURE.md](../ARCHITECTURE.md)

## Development Commands

```bash
# Run the compiler
bun run src/index.ts

# Run with file watching
bun run --watch src/index.ts
```

## Module Exports

Each subdirectory exports its public API via `index.ts`:

```typescript
// Instead of:
import parse from './parser/parser.ts'

// You can use:
import { parse } from './parser'
```

This keeps imports clean and provides a single point to control what's public.

