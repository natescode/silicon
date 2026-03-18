# Silicon Minimal Intermediate Representation (IR)

## Overview

The **Silicon IR** is a minimal, normalized representation that sits between the AST and WebAssembly code generation. It serves as a bridge that:

- Decouples semantic analysis from code generation
- Provides a simple, canonical form for optimization and analysis
- Makes it easier to support multiple backends (or language targets)
- Simplifies the path from AST → WAT

### Current Pipeline vs. Proposed Pipeline

**Current:**
```
Source → Parser → AST → WAT
```

**Proposed:**
```
Source → Parser → AST → Elaborator → IR → Codegen → WAT
```

The IR is **lower-level than the AST** but **higher-level than WAT**. It's essentially "AST without syntax sugar."

---

## Design Principles

1. **Minimalism**: Only include what's necessary for code generation
2. **Normalization**: No syntactic variants (one way to represent each concept)
3. **Explicitness**: Make all implicit information explicit (types, control flow)
4. **Composability**: IR constructs should compose cleanly without special cases
5. **Direct Codegen**: IR → WAT should be straightforward (nearly 1:1 in many cases)

---

## Core IR Types

### Programs and Definitions

```typescript
// Entry point - a collection of definitions and a main expression
interface Program {
  type: 'Program'
  definitions: Definition[]
  main?: Expression  // Optional main expression/statement
}

// All top-level declarations
type Definition =
  | FunctionDef
  | GlobalDef
  | TypeDef  // For future type system

interface FunctionDef {
  type: 'FunctionDef'
  name: string
  params: Parameter[]
  returnType: Type
  body: Expression
}

interface Parameter {
  name: string
  type: Type
}

interface GlobalDef {
  type: 'GlobalDef'
  name: string
  type: Type
  init: Expression
}
```

### Types

```typescript
// Minimal type system
type Type = 
  | { kind: 'i32' }
  | { kind: 'f32' }
  | { kind: 'string' }
  | { kind: 'array'; elementType: Type }
  | { kind: 'object'; fields: Record<string, Type> }
  | { kind: 'tuple'; elementTypes: Type[] }
  | { kind: 'void' }

// Type inference should have resolved all types by the time we reach IR
```

### Expressions

The IR normalizes all expressions into a few canonical forms:

```typescript
type Expression =
  | Literal
  | Variable
  | BinaryOp
  | Unary
  | Call
  | MemoryOp
  | Control
  | Sequence

// Simple values (no nesting, fully evaluated at compile time)
interface Literal {
  type: 'Literal'
  kind: 'int' | 'float' | 'string' | 'bool' | 'null'
  value: any
  valueType: Type
}

interface Variable {
  type: 'Variable'
  name: string
  valueType: Type
}

// Binary operations (left and right are always simple)
interface BinaryOp {
  type: 'BinaryOp'
  operator: '+' | '-' | '*' | '/' | '==' | '!=' | '<' | '>' | '<=' | '>=' | '&&' | '||'
  left: SimpleExpr
  right: SimpleExpr
  resultType: Type
}

// Unary operations
interface Unary {
  type: 'Unary'
  operator: '-' | '!' | 'typeof'
  operand: SimpleExpr
  resultType: Type
}

// Function calls
interface Call {
  type: 'Call'
  target: string | SimpleExpr  // Function name or computed
  args: SimpleExpr[]
  resultType: Type
}

// Memory operations (load/store)
interface MemoryOp {
  type: 'MemoryOp'
  kind: 'load' | 'store' | 'alloc'
  address?: SimpleExpr  // For load/store
  value?: SimpleExpr    // For store
  size?: number         // For alloc
  resultType: Type
}

// Control flow
interface Control {
  type: 'Control'
  kind: 'if' | 'block' | 'loop' | 'return'
  condition?: SimpleExpr
  thenBranch?: Expression
  elseBranch?: Expression
  body?: Expression
  resultType: Type
}

// Multiple expressions in sequence
interface Sequence {
  type: 'Sequence'
  expressions: Expression[]
  resultType: Type  // Type of the last expression
}

// Simplified: no deeply nested expressions
type SimpleExpr = Literal | Variable | Call | MemoryOp
```

---

## Key Design Decisions

### 1. **Flattened Expressions**

AST expressions can be arbitrarily nested:
```
5 + (3 * (foo(bar()) + 2))
```

IR flattens this conceptually:
```
let $tmp1 = bar()
let $tmp2 = foo($tmp1)
let $tmp3 = 3 * ($tmp2 + 2)
let $tmp4 = 5 + $tmp3
return $tmp4
```

Codegen doesn't need to do this—it can generate nested WAT instructions. But the IR *conceptually* represents a flattened form for clarity.

### 2. **Type Information Everywhere**

Every expression includes its `resultType`. This makes code generation straightforward:
- No need to infer types during codegen
- Simple discrimination: `i32.add` vs `f32.add`

### 3. **Minimal Control Flow**

Only include what WASM needs:
- `if-then-else`
- `block` (for returns)
- `loop` (for repetition)
- `return` (explicit)

No `switch`, `for`, `while` — those are elaborated to basic blocks in the elaborator.

### 4. **Memory as an IR Primitive**

Heaps, objects, and arrays all use memory:
```typescript
// Allocate 4 words (16 bytes) for an object
let addr = MemoryOp { kind: 'alloc', size: 16 }

// Store to offset
MemoryOp { 
  kind: 'store', 
  address: add(addr, 0), 
  value: intLit(42) 
}

// Load from offset
MemoryOp { 
  kind: 'load', 
  address: add(addr, 0) 
}
```

---

## Example: AST → IR Transformation

**Silicon source:**
```
@let x = 5
@let y = x + 3
print(y)
```

**AST (current):**
```
Program {
  elements: [
    Element {
      value: Item {
        value: Statement {
          kind: 'assignment',
          value: Assignment {
            target: Namespace { name: 'x' },
            value: ExpressionStart { ... Literal(5) ... }
          }
        }
      }
    },
    ...
  ]
}
```

**IR:**
```
Program {
  definitions: [
    GlobalDef {
      name: 'x',
      type: { kind: 'i32' },
      init: Literal { kind: 'int', value: 5, valueType: i32 }
    },
    GlobalDef {
      name: 'y',
      type: { kind: 'i32' },
      init: BinaryOp {
        operator: '+',
        left: Variable { name: 'x', valueType: i32 },
        right: Literal { kind: 'int', value: 3, valueType: i32 },
        resultType: { kind: 'i32' }
      }
    }
  ],
  main: Call {
    target: 'print',
    args: [Variable { name: 'y', valueType: i32 }],
    resultType: { kind: 'void' }
  }
}
```

**Note:** The IR visitor has resolved:
- Implicit integer types (no ambiguity about types)
- Statement/Expression distinction is gone (everything is expression-like)
- Namespace paths are resolved to simple names

---

## File Organization

Add these files to your codebase:

```
src/
├── ir/                         # NEW
│   ├── index.ts               # Export IR types and builder
│   ├── types.ts               # Type definitions
│   ├── builder.ts             # IRBuilder helper
│   └── ir.integration.test.ts # IR tests
```

---

## Implementation Roadmap

### Phase 1: Define IR (This Phase)
- [ ] Finalize IR type definitions
- [ ] Create `src/ir/types.ts`
- [ ] Add IR builder utilities

### Phase 2: AST → IR Transformation
- [ ] Create `src/ir/fromAst.ts` (AST to IR converter)
- [ ] Implement type inference during conversion
- [ ] Test with existing AST test cases

### Phase 3: IR → WAT Codegen
- [ ] Refactor `src/codegen/compile.ts` to work with IR
- [ ] Simplify codegen (remove type inference logic)
- [ ] Verify output matches current WAT generation

### Phase 4: Optimization (Future)
- [ ] Dead code elimination pass
- [ ] Constant folding
- [ ] Register allocation

---

## Comparison: AST vs. IR

| Aspect | AST | IR |
|--------|-----|-----|
| **Nesting** | Arbitrary | Flattened (conceptually) |
| **Types** | Inferred during codegen | Explicit everywhere |
| **Syntax** | Preserves all syntax forms | Normalized |
| **Control Flow** | Conditionals + loops | if/block/loop/return only |
| **Scope** | Lexical paths | Simple names (resolved) |
| **Memory** | Not explicit | Explicit operations |
| **Size** | Larger (more variants) | Smaller (fewer variants) |

---

## Minimal Example: Complete IR

```typescript
const exampleIR: Program = {
  type: 'Program',
  definitions: [
    {
      type: 'FunctionDef',
      name: 'add',
      params: [
        { name: 'a', type: { kind: 'i32' } },
        { name: 'b', type: { kind: 'i32' } }
      ],
      returnType: { kind: 'i32' },
      body: {
        type: 'BinaryOp',
        operator: '+',
        left: { type: 'Variable', name: 'a', valueType: { kind: 'i32' } },
        right: { type: 'Variable', name: 'b', valueType: { kind: 'i32' } },
        resultType: { kind: 'i32' }
      }
    }
  ],
  main: {
    type: 'Call',
    target: 'add',
    args: [
      { type: 'Literal', kind: 'int', value: 3, valueType: { kind: 'i32' } },
      { type: 'Literal', kind: 'int', value: 4, valueType: { kind: 'i32' } }
    ],
    resultType: { kind: 'i32' }
  }
}
```

This IR is small, explicit, and maps directly to WASM.

---

## Next Steps

1. **Review** this design with your team
2. **Refine** based on your specific needs (are there missing features?)
3. **Implement** Phase 1: IR type definitions
4. **Iterate** on the AST → IR transformation

Would you like me to help implement the IR types, or would you like to discuss modifications to this design first?
