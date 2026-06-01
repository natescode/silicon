// SPDX-License-Identifier: MIT
/**
 * Hand-written, dependency-free LL(1) recursive-descent parser for Silicon.
 *
 * Produces the same AST as the ohm-based parser (`../index`), verified
 * node-equal over the corpus in equivalence.test.ts. It is NOT yet wired into
 * the pipeline — ohm remains the default `parse()`; this coexists so it can be
 * proven a drop-in (and eventually replace ohm to drop the last runtime dep).
 *
 * Verified node-equal to ohm over the whole corpus (equivalence.test.ts) and
 * ~30–36 MiB/s, 292–3085x faster than ohm. To run the equivalence test or the
 * benchmarks, see ../../../bench/README.md.
 *
 * @see parser.ts  - the recursive-descent parser (parseToAst)
 * @see lexer.ts   - the tokenizer
 * @see ../../../bench/README.md - how to run the benchmark + profile
 */

export { parseToAst, default } from './parser'
export { Lexer, tokenize, lineColumn, type Token } from './lexer'
