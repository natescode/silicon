// SPDX-License-Identifier: MIT
/**
 * Sentinel `siliconGrammar` export.
 *
 * ohm has been removed; the hand-written parser (parser/handwritten/) needs no
 * grammar object. Call sites that still pass `siliconGrammar` into the
 * `addToAstSemantics` shim (see ../ast/toAst.ts) get this inert sentinel, which
 * the shim ignores. Kept only so those import paths still resolve.
 */
const siliconGrammar = { __handwritten: true as const }

export default siliconGrammar
