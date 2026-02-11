# Developer Setup Guide

This guide will get you set up for Silicon development in 5 minutes.

## Prerequisites

- **Node.js** 18+ (we use Bun, which works with Node 18+)
- **Bun** 1.0+ - [Install](https://bun.sh/)
- **git**

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/yourusername/sigil.git
cd sigil
bun install
```

### 2. Run the Compiler

```bash
bun run src/index.ts
```

This compiles the test program in `index.ts` and generates:
- `ast.json` - The intermediate AST representation
- `main.wat` - WebAssembly text format

### 3. Verify WAT Output

```bash
cat main.wat
```

## Project Commands

```bash
# Run the compiler
bun run src/index.ts

# Run the compiler in watch mode (re-runs on file changes)
bun run --watch src/index.ts

# Format code
bun format

# Type check
bun type-check
```

## Understanding the Code

**New to the codebase?** Read these in order:

1. [ARCHITECTURE.md](./ARCHITECTURE.md) - System overview (5 min read)
2. `src/index.ts` - Follow the pipeline flow (2 min read)
3. `src/parser/parser.ts` - How parsing works (2 min read)
4. `src/ast/` - AST structure and transformation (10 min read)
5. `src/codegen/compile.ts` - Code generation (15 min read)

## Making Changes

### Adding a New Language Feature

For example, adding an `@if` statement:

#### Step 1: Update Grammar

Edit `src/grammar/silicon-official.ohm`:
```ohm
Statement = | Assignment
            | Definition
            | IfStatement  -- new rule
            
IfStatement = "@if" ExpressionStart "{" Item* "}" ("else" "{" Item* "}")?
```

#### Step 2: Add AST Nodes

Edit `src/ast/astNodes.ts`:
```typescript
export interface IfStatement {
    type: 'IfStatement'
    condition: ExpressionStart
    thenBranch: Item[]
    elseBranch?: Item[]
    sourceLocation?: SourceLocation
}

// Add to ASTFactory:
ifStatement(condition, thenBranch, elseBranch?): IfStatement {
    return { type: 'IfStatement', condition, thenBranch, elseBranch }
}
```

#### Step 3: Add Semantic Actions

Edit `src/ast/toAst.ts`:
```typescript
IfStatement(keyword, cond, open1, then_items, rest) {
    const condition = cond.toAst()
    const thenBranch = then_items.children.map(item => item.toAst())
    const elseBranch = rest.children.length > 0 
        ? rest.toAst() 
        : undefined
    return ASTFactory.ifStatement(condition, thenBranch, elseBranch)
}
```

Edit `src/codegen/compile.ts`:
```typescript
IfStatement(keyword, cond, open1, then_items, rest) {
    const condWat = cond.compile()
    const thenWat = then_items.children
        .map(item => item.compile())
        .filter(s => s)
        .join('\n')
    
    // Generate block and branch instructions
    return `(block
  (block
    ${condWat}
    (br_if 1)
    ${thenWat}
    (return)
  )
  ${rest.compile() || ''}
)`
}
```

#### Step 4: Test

Update the test code in `src/index.ts`:
```typescript
const sourceCode = `@if @true { &@log 5; };`
```

Run: `bun run src/index.ts`

Check the generated `ast.json` and `main.wat` to verify correctness.

## Debugging

### Print AST Structure

The compiler outputs AST to console:
```bash
bun run src/index.ts | grep "AST:"
```

Pretty-printed AST is also saved to `ast.json`.

### Debug Parse Tree

To see the parse tree (before AST):
```typescript
// In index.ts, add:
console.log(match.tree)
```

### Test Grammar Rules

Test a specific grammar rule:
```typescript
// In a test file:
import siliconGrammar from './src/grammar/SiliconGrammar'

const testGrammar = siliconGrammar.clone()
const match = testGrammar.match('YOUR_CODE', 'RuleName')  // Match specific rule
```

## Common Issues

### "Parse error" on valid code

1. Check `src/grammar/silicon-official.ohm` for the rule syntax
2. Verify tokens match exactly (e.g., `@if` not `@IF`)
3. Run: `bun run src/index.ts` and look at the error message

### WAT looks wrong

1. Check `src/ast/toAst.ts` - is the AST correct?
2. Check `ast.json` for the actual AST generated
3. Add debug logging in `src/codegen/compile.ts`

### Changes not taking effect

Bun caches modules. Use the `--watch` flag or clear the cache:
```bash
rm -rf .bun  # Clears Bun cache
bun run src/index.ts
```

## Code Style

- Use 4 spaces for indentation
- Prefer `const` over `let`
- Add JSDoc comments to public functions
- Use TypeScript interfaces for all data structures

## Testing

Tests aren't set up yet, but here's how to add them:

```bash
bun test src/__tests__/parser.test.ts
```

## Getting Help

- See [ARCHITECTURE.md](./ARCHITECTURE.md) for system overview
- Check [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidelines
- Open an issue on GitHub with:
  - Your code snippet
  - Expected vs actual output
  - Error messages
  - Your environment (Node/Bun versions)

## Next Steps

1. Run the compiler: `bun run src/index.ts`
2. Read [ARCHITECTURE.md](./ARCHITECTURE.md)
3. Make a small change to test your understanding
4. Contribute! See [CONTRIBUTING.md](./CONTRIBUTING.md)

