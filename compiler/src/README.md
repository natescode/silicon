# Silicon Compiler Source Code

This directory contains the source code for the Silicon compiler.

## Structure

```
src/
├── index.ts              # Entry point - orchestrates the compilation pipeline
│
├── parser/               # Stage 1: Parsing (source code → parse tree)
│   ├── index.ts          # Module exports
│   └── parser.ts         # Parse implementation
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
└── grammar/              # Grammar Definitions
    ├── index.ts          # Module exports
    ├── SiliconGrammar.ts # Grammar loader
    └── silicon-official.ohm # Grammar rules
```

## Quick Reference

### Main Entry Point

- **index.ts** - Start here. Shows the full pipeline: parse → AST → codegen

### The Three Compilation Stages

1. **Parser** (`parser/parser.ts`)
   - Input: Source code (string)
   - Output: Parse tree (Ohm Match object)
   - Uses grammar rules from `grammar/silicon-official.ohm`

2. **AST** (`ast/`)
   - Input: Parse tree
   - Output: Strongly-typed AST
   - `astNodes.ts`: Type definitions
   - `toAst.ts`: Transformation logic

3. **Codegen** (`codegen/compile.ts`)
   - Input: AST
   - Output: WebAssembly (WAT format)
   - `std.wat`: Standard library functions

### Grammar

- **silicon-official.ohm** - Formal grammar specification
- **SiliconGrammar.ts** - Loads and compiles the grammar

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

