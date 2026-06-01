// SPDX-License-Identifier: MIT
/**
 * Compatibility shim for the former ohm semantics.
 *
 * ohm has been removed: `parse(src)` (parser/parser.ts) now returns the typed
 * AST directly via the hand-written parser, which already reproduces the exact
 * AST this module used to build. Many call sites still use the historical
 * two-step form:
 *
 *     addToAstSemantics(siliconGrammar)(parse(src)).toAst()
 *
 * so this shim keeps that shape working: `addToAstSemantics` ignores its
 * (sentinel) grammar argument and returns a wrapper whose `.toAst()` yields the
 * already-parsed AST unchanged. New code should just call `parse(src)`.
 *
 * @see ../parser/handwritten/parser.ts - the parser that builds the AST
 */

/** Identity semantics: the input is already the AST. */
export default function addToAstSemantics(_grammar?: unknown) {
    return (parsed: unknown) => ({ toAst: () => parsed })
}
