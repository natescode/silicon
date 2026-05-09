/**
 * Silicon Compiler Entry Point
 *
 * Orchestrates the compilation pipeline:
 *
 *   1. PARSE      - Source → Ohm parse tree
 *   2. AST        - Parse tree → typed AST
 *   3. ELABORATE  - Attach semantic information to operators (Strata)
 *   4. TYPECHECK  - Infer types, annotate AST, collect type errors
 *   5. CODEGEN    - AST → WebAssembly text format (WAT)
 *
 * Output artifacts:
 *   - ast.json: elaborated + type-annotated AST (useful for debugging)
 *   - main.wat: WebAssembly text format (assemble with wat2wasm)
 *
 * @example
 *   bun run src/index.ts
 */

import parse from './parser'
import { addToAstSemantics, type ASTNode, type Program } from './ast'
import { addCompileSemantics } from './codegen'
import { elaborate } from './elaborator'
import { typecheck, formatTypeError } from './types'
import { siliconGrammar } from './grammar'

console.log('Silicon v2024.01')

// Example Silicon program
// TODO: accept input from CLI or files
const sourceCode = `5;`

// ============================================================================
// COMPILATION PIPELINE
// ============================================================================

// Stage 1: Parse source code into parse tree
const match = parse(sourceCode)

// Stage 2: Convert parse tree into typed AST
const ast: ASTNode = addToAstSemantics(siliconGrammar)(match).toAst()

// Stage 2.5: Elaborate — attach semantic information to operators
const { program: elaboratedAST, registry } = elaborate(ast as Program)

// Stage 2.6: Type-check — annotate the AST with inferred types
const { program: typedAST, errors: typeErrors, functions } = typecheck(elaboratedAST, registry)

if (typeErrors.length > 0) {
    console.error('Type errors:')
    for (const err of typeErrors) {
        console.error('  ' + formatTypeError(err))
    }
    process.exit(1)
}

// Stage 3: Generate WebAssembly from AST
const wat: string = addCompileSemantics(siliconGrammar, registry, functions)(match).compile()

// ============================================================================
// OUTPUT ARTIFACTS
// ============================================================================

await Bun.write('ast.json', JSON.stringify(typedAST, null, 2))
await Bun.write('main.wat', wat)

console.log('AST:', JSON.stringify(typedAST, null, 2))
