/**
 * Silicon Compiler Entry Point
 *
 * This is the main driver for the Silicon compiler. It orchestrates the compilation
 * pipeline:
 *
 *   1. PARSE      - Convert source code into a parse tree using the Ohm grammar
 *   2. AST        - Transform parse tree into a strongly-typed Abstract Syntax Tree
 *   3. ELABORATE  - Attach semantic information to operators from elaborator registry
 *   4. CODEGEN    - Generate WebAssembly Text format (WAT) from the AST
 *
 * The compiler outputs two artifacts:
 *   - ast.json: The intermediate representation (useful for debugging and analysis)
 *   - main.wat: WebAssembly text format (can be converted to .wasm with wat2wasm)
 *
 * @example
 *   bun run src/index.ts
 */

import parse from './parser'
import { addToAstSemantics, type ASTNode, Program } from './ast'
import { addCompileSemantics } from './codegen'
import { elaborate } from './elaborator'
import { siliconGrammar } from './grammar'

console.log('Silicon v2024.01')

// Example Silicon program
// TODO: Make this accept input from CLI or files  
const sourceCode = `5;`

// ============================================================================
// COMPILATION PIPELINE
// ============================================================================

// Stage 1: Parse source code into parse tree
const match = parse(sourceCode)

// Stage 2: Convert parse tree into typed AST
const ast: ASTNode = addToAstSemantics(siliconGrammar)(match).toAst()

// Stage 2.5: Elaborate - attach semantic information to operators
const elaboratedAST = elaborate(ast as Program)

// Stage 3: Generate WebAssembly from AST
const wat: string = addCompileSemantics(siliconGrammar)(match).compile()

// ============================================================================
// OUTPUT ARTIFACTS
// ============================================================================

await Bun.write('ast.json', JSON.stringify(elaboratedAST, null, 2))
await Bun.write('main.wat', wat)

console.log('AST:', JSON.stringify(elaboratedAST, null, 2))