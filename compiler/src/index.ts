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
import { compileToWat } from './codegen'
import { elaborate, buildStrataRegistry } from './elaborator'
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

// Stage 2.5a: Build strata registry from builtin .si files + user @stratum definitions
const registry = buildStrataRegistry(ast as Program)

// Stage 2.5b: Elaborate — walk AST and attach registry data to operator/definition nodes
const { program: elaboratedAST, errors: elabErrors } = elaborate(ast as Program, registry)

if (elabErrors.length > 0) {
    console.error('Elaboration errors:')
    for (const err of elabErrors) {
        console.error('  ' + err.message)
    }
    process.exit(1)
}

// Stage 2.6: Type-check — annotate the AST with inferred types
const { program: typedAST, errors: typeErrors, functions } = typecheck(elaboratedAST, registry)

if (typeErrors.length > 0) {
    console.error('Type errors:')
    for (const err of typeErrors) {
        console.error('  ' + formatTypeError(err))
    }
    process.exit(1)
}

// Stage 3: Lower typed AST → IR → WAT
const wat: string = compileToWat(typedAST, registry, functions)

// ============================================================================
// OUTPUT ARTIFACTS
// ============================================================================

await Bun.write('ast.json', JSON.stringify(typedAST, null, 2))
await Bun.write('main.wat', wat)

console.log('AST:', JSON.stringify(typedAST, null, 2))
