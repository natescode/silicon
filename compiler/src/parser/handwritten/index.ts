// SPDX-License-Identifier: MIT
/**
 * Hand-written, dependency-free LL(1) recursive-descent parser for Silicon.
 *
 * Produces the same AST as the ohm-based parser (`../index`), verified
 * node-equal over the corpus in equivalence.test.ts. It is NOT yet wired into
 * the pipeline — ohm remains the default `parse()`; this coexists so it can be
 * proven a drop-in (and eventually replace ohm to drop the last runtime dep).
 *
 * @see parser.ts  - the recursive-descent parser (parseToAst)
 * @see lexer.ts   - the tokenizer
 */

export { parseToAst, default } from './parser'
export { Lexer, tokenize, lineColumn, type Token } from './lexer'
