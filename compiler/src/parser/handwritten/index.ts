// SPDX-License-Identifier: MIT
/**
 * Hand-written, dependency-free LL(1) recursive-descent parser for Silicon.
 *
 * This IS the parser: `parse()` (../parser.ts) calls `parseToAst` directly.
 * It replaced the former ohm-js PEG parser (ohm removed), produces the same
 * AST, and runs ~30–36 MiB/s. See ../../../bench/README.md for the benchmark,
 * profile, and the ohm-era speedup history.
 *
 * @see parser.ts  - the recursive-descent parser (parseToAst)
 * @see lexer.ts   - the tokenizer
 * @see ../../../bench/README.md - how to run the benchmark + profile
 */

export { parseToAst, default } from './parser'
export { Lexer, tokenize, lineColumn, type Token } from './lexer'
