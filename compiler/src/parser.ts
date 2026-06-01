// SPDX-License-Identifier: MIT
// Parses Silicon source to the typed AST via the hand-written parser.
// (ohm removed; see parser/parser.ts and parser/handwritten/.)
import { parseToAst } from './parser/handwritten/parser'

export default function parse(sourceCode: string) {
    return parseToAst(sourceCode)
}
