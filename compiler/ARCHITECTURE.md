# Silicon Compiler Architecture

This document describes the architecture of the Silicon compiler and how to navigate the codebase.

## Overview

The Silicon compiler is built around a **three-stage pipeline**:

```
Source Code → Parse → AST → Compile → WAT → WASM
```

Each stage is independent and modular, making the codebase easy to understand and modify.

## Project Structure

```
sigil/
├── src/
│   ├── index.ts              # Entry point - orchestrates the pipeline
│   │
│   ├── parser/               # Stage 1: Parsing
│   │   └── parser.ts         # Parse source code into parse tree
│   │
│   ├── ast/                  # Stage 2: AST Construction
│   │   ├── astNodes.ts       # Type definitions for AST nodes
│   │   └── toAst.ts          # Parse tree → AST transformation
│   │
│   ├── codegen/              # Stage 3: Code Generation
│   │   ├── compile.ts        # AST → WebAssembly code
│   │   └── std.wat           # Standard library functions
│   │
│   ├── grammar/              # Grammar Definition
│   │   ├── silicon-official.ohm  # Grammar rules
│   │   └── SiliconGrammar.ts     # Grammar loader
│   │
│   └── sigil_cli.ts          # CLI interface (future)
│
├── README.md                 # Project overview
├── ARCHITECTURE.md           # This file
├── CONTRIBUTING.md           # Contribution guidelines
└── DEVELOP.md                # Developer setup guide
```

## Stage 1: Parser (`src/parser/`)

**Input**: Silicon source code (string)  
**Output**: Ohm Match object (parse tree)  
**Module**: `parser.ts`

The parser uses the Ohm parsing library to convert source code into a parse tree according to the grammar rules defined in `silicon-official.ohm`.

Key concepts:
- **Grammar**: Formal specification of Silicon syntax in BNF-like format
- **Parse Tree**: Concrete syntax tree with all tokens and whitespace
- **Match Object**: Ohm's representation of a successful parse

## Stage 2: AST (`src/ast/`)

**Input**: Ohm Match object (parse tree)  
**Output**: Strongly-typed AST  
**Modules**: `astNodes.ts`, `toAst.ts`

This stage transforms the raw parse tree into a clean, strongly-typed Abstract Syntax Tree.

### astNodes.ts
Defines all AST node types using TypeScript interfaces:
- `Program` - Root node containing all top-level elements
- `Statement` - Assignment or Definition
- `Expression` - Binary operations, function calls, literals, etc.
- `Literal` - Strings, numbers, arrays, objects, etc.

Each node has:
- A discriminating `type` field for safe pattern matching
- A `kind` field (where applicable) to distinguish variants
- Optional `sourceLocation` for error reporting

### toAst.ts
Implements semantic actions that transform the parse tree:
- One semantic action per grammar rule
- Uses `ASTFactory` to ensure type safety
- Filters out parse tree noise (whitespace, tokens)
- Preserves all semantic information

## Stage 3: Codegen (`src/codegen/`)

**Input**: Strongly-typed AST  
**Output**: WebAssembly text format (WAT)  
**Module**: `compile.ts`

This stage transforms the AST into executable WebAssembly code.

Key features:
- Type inference (distinguishes i32 vs f32 operations)
- Memory layout management (heap at 1024+)
- Function definition generation
- Expression-to-instruction translation

Output is valid WAT that can be:
- Assembled to WASM: `wat2wasm main.wat -o main.wasm`
- Executed: `wasmer main.wasm`

## Grammar (`src/grammar/`)

**Modules**: `silicon-official.ohm`, `SiliconGrammar.ts`

- **silicon-official.ohm**: The grammar specification using Ohm's syntax
  - Defines what constitutes valid Silicon code
  - Rules for expressions, statements, literals, etc.
  
- **SiliconGrammar.ts**: Loads and compiles the grammar
  - Reads the `.ohm` file at runtime
  - Returns an Ohm Grammar object usable by parser and semantic actions

## Data Flow Example

Here's how a simple Silicon program flows through the compiler:

```
Input: "@fn add x, y = x + y;"

↓ Parser

Match {
  ruleName: "Program"
  value: [ ... parse tree nodes ... ]
}

↓ toAst (Semantic Actions)

Program {
  type: 'Program'
  elements: [
    {
      type: 'Element'
      kind: 'item'
      value: Definition {
        type: 'Definition'
        keyword: '@fn'
        name: { type: 'TypedIdentifier', name: 'add' }
        params: [
          { type: 'Parameter', name: 'x' }
          { type: 'Parameter', name: 'y' }
        ]
        binding: { type: 'Binding', ... }
      }
    }
  ]
}

↓ Compile (Semantic Actions)

(module
  (memory 1)
  (global $heap (mut i32) (i32.const 1024))
  (func $add (param $x i32) (param $y i32) (result i32)
    (local.get $x)
    (local.get $y)
    (i32.add)
  )
)
```

## Key Design Patterns

### Semantic Actions
Each compilation stage uses Ohm's semantic action pattern:
```typescript
grammar.createSemantics().addOperation('operationName', {
  RuleName(child1, child2, ...) {
    // Transform children and return result
    return transformedValue
  }
})
```

### Type Safety
- All AST nodes are TypeScript interfaces
- Factory functions ensure consistent node creation
- Discriminated unions enable safe pattern matching

### Separation of Concerns
- Parser focuses on syntax validation
- AST handles semantic structure
- Codegen handles translation to WAT

## Contributing

When adding new features:

1. **Extend the grammar** (`silicon-official.ohm`) - Define new syntax rules
2. **Add AST nodes** (`astNodes.ts`) - Create corresponding types
3. **Add semantic actions** (`toAst.ts`, `compile.ts`) - Implement transformation logic

See [CONTRIBUTING.md](./CONTRIBUTING.md) for detailed guidelines.

## References

- [Ohm Language](https://ohmjs.org/) - Parsing library
- [WebAssembly](https://webassembly.org/) - Target format
- [WAT Format](https://webassembly.org/docs/text-format/) - Human-readable WASM

