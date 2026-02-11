/**
 * AST Module
 *
 * Stage 2 of the compilation pipeline: Transform parse tree into typed AST.
 *
 * @see astNodes.ts - Type definitions for all AST nodes
 * @see toAst.ts - Parse tree → AST transformation
 */

export type { ASTNode } from './astNodes'
export { ASTFactory } from './astNodes'
export { default as addToAstSemantics } from './toAst'
