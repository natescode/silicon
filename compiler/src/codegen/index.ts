/**
 * Code Generation Module
 *
 * Stage 3 of the compilation pipeline: Transform AST into WebAssembly.
 *
 * @see compile.ts - AST → WAT code generation
 * @see std.wat - Standard library functions
 */

export { default as addCompileSemantics } from './compile'
