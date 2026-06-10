// SPDX-License-Identifier: MIT
/**
 * Match-arm normalization.
 *
 * `@match` is an ordinary builtin function call (Silicon's "built-ins are
 * functions" stance): the discriminant followed by alternating pattern / body
 * arguments, each body a `{ … }` block —
 *
 *     @match(disc,
 *         $Some v, { v },
 *         $None,   { dflt })
 *
 * Because a body is a brace-delimited block it is a single argument, so an arm
 * body can be any expression (`{ v * 2 }`, `{ 0 - 1 }`) with no dependence on
 * operator precedence — Silicon's operators are flat (left-to-right, equal), and
 * `@match` deliberately needs no exception to that.  There is NO infix arm
 * operator: the old `pattern => body` form is gone (an infix `=>` collided with
 * flat precedence the moment a body was itself a binary expression).
 *
 * Per-arm pattern alternation reuses the `|` already used in `@type`:
 *
 *     @match(c,
 *         $Red | $Green, { 'warm' },
 *         $Blue,         { 'cool' })
 *
 * A trailing single argument (odd count after the discriminant) is a catch-all
 * default, preserved verbatim.
 *
 * This module flattens alternation into the shape the match typechecker /
 * lowerer consume — `[disc, pat, body, pat, body, …, (default)]` — by
 * duplicating the body across a `|`-arm's alternatives.  Bodies are AST
 * references, not deep-cloned: fine, since arms run at most once each.
 */

/**
 * Normalize a `@match` call's args.  Walks the (pattern, body) pairs after the
 * discriminant, expanding any `|`-alternation pattern into one arm per
 * alternative sharing the body.  A non-`|` pattern passes through 1:1, so a
 * plain `[disc, pat, body, …]` is unchanged.  A trailing odd arg is a default.
 *
 *   `disc, $Red | $Green, { 'warm' }, $Blue, { 'cool' }`
 *      ↓
 *   `disc, $Red, { 'warm' }, $Green, { 'warm' }, $Blue, { 'cool' }`
 */
export function normalizeMatchArgs(rawArgs: any[]): any[] {
    if (rawArgs.length < 2) return rawArgs
    const out: any[] = [rawArgs[0]]
    let i = 1
    while (i < rawArgs.length) {
        const pat = rawArgs[i]
        assertNotArrowArm(pat)
        // A trailing pattern with no following body is the catch-all default.
        if (i + 1 >= rawArgs.length) { out.push(pat); break }
        const body = rawArgs[i + 1]
        for (const p of collectAltPatterns(pat)) {
            out.push(p)
            out.push(body)
        }
        i += 2
    }
    return out
}

/** The `pattern => body` arm form was removed — a leftover `=>` parses (under
 *  flat precedence) into the pattern slot.  Fail loudly with the migration so it
 *  can never silently mis-lower. */
function assertNotArrowArm(node: any): void {
    if (node != null && node.type === 'BinaryOp' && node.operator === '=>') {
        throw new Error(
            "@match no longer uses the `pattern => body` arm form — write the body as a block argument instead: `@match(x, $Some v, { v }, $None, { dflt })`",
        )
    }
}

/** Collect `|`-chained patterns into a flat list.  `$A | $B | $C` → [$A, $B, $C]. */
function collectAltPatterns(node: any): any[] {
    if (node != null && node.type === 'BinaryOp' && node.operator === '|') {
        return [...collectAltPatterns(node.left), ...collectAltPatterns(node.right)]
    }
    return [node]
}
