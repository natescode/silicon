// SPDX-License-Identifier: MIT
/**
 * Silicon Parser
 *
 * Stage 1 of the compilation pipeline. Parses Silicon source into the typed AST
 * via the hand-written, dependency-free recursive-descent parser in
 * `./handwritten`. (Previously ohm-based; ohm has been removed.)
 *
 * `parse(src)` returns the AST `Program` directly — the old two-step
 * `addToAstSemantics(grammar)(parse(src)).toAst()` still works because
 * addToAstSemantics is now an identity shim (see ../ast/toAst.ts).
 *
 * @throws {Error} `Parse error: Line N, col M: …` if the input is invalid
 */

import { parseToAst } from './handwritten/parser'

export default function parse(sourceCode: string) {
    return parseToAst(sourceCode)
}
