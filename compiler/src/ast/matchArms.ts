// SPDX-License-Identifier: MIT
/**
 * Match-arm normalization.
 *
 * `&@match` is a builtin function call.  The legacy "flat" form passes
 * patterns and bodies as alternating args:
 *
 *     &@match disc, pat0, body0, pat1, body1, …
 *
 * The "arm-expression" form folds each (pattern, body) pair into a single
 * arg shaped as a `BinaryOp` with operator `=>`:
 *
 *     &@match disc,
 *         pat0 => body0,
 *         pat1 => body1
 *
 * Per-arm pattern alternation uses the same `|` already used in `@type`:
 *
 *     &@match c,
 *         $Red | $Green => 'warm',
 *         $Blue => 'cool'
 *
 * Both forms require *zero grammar changes* — `=>` and `|` are already valid
 * `BinaryOp` operators.  This module flattens the arm-expression form back
 * into the flat shape so the existing match typechecker / lowerer can
 * consume either form uniformly.
 *
 * Pattern alternation expands by *duplicating the body* across the alternatives
 * — `$Red | $Green => 'warm'` becomes flat `[$Red, 'warm', $Green, 'warm']`.
 * Bodies are AST references, not deep-cloned: this is fine because match
 * arms run at most once each (they're branches of an if-then-else chain).
 */

/** Detect arm-expression form by checking if any arg after the discriminant
 *  is shaped as `pattern => body`.  Pure inspection — no mutation. */
export function isArmExpressionForm(rawArgs: any[]): boolean {
    if (rawArgs.length < 2) return false
    return rawArgs.slice(1).some(a => extractArm(a) != null)
}

/**
 * Normalize a `&@match` call's args.  If the call uses arm-expression form,
 * flatten into `[disc, pat, body, pat, body, …]`.  Otherwise pass through.
 *
 *   `disc, $Some v => v, $None => dflt`
 *      ↓
 *   `disc, $Some v, v, $None, dflt`
 *
 * Pattern alternation inside an arm expands:
 *
 *   `disc, $Red | $Green => 'warm', $Blue => 'cool'`
 *      ↓
 *   `disc, $Red, 'warm', $Green, 'warm', $Blue, 'cool'`
 *
 * An arg that is *not* arm-expression-shaped is passed through verbatim —
 * this preserves the trailing-default behavior (`disc, pat, body, dflt`)
 * and lets the new and legacy forms coexist within one call (intentional
 * for backwards compatibility; the legacy form is not deprecated).
 */
export function normalizeMatchArgs(rawArgs: any[]): any[] {
    if (!isArmExpressionForm(rawArgs)) return rawArgs

    const out: any[] = [rawArgs[0]]
    for (let i = 1; i < rawArgs.length; i++) {
        const a = rawArgs[i]
        const arm = extractArm(a)
        if (arm) {
            const patterns = collectAltPatterns(arm.pattern)
            for (const pat of patterns) {
                out.push(pat)
                out.push(arm.body)
            }
        } else {
            // Arg without `=>` in arm-expression mode is a trailing default
            // (the existing semantics) or, if it's not the last arg, a legacy
            // flat-form arg that the rest of the pipeline handles.
            out.push(a)
        }
    }
    return out
}

/**
 * Recover one `pattern => body` arm, returning its pattern and body nodes — or
 * `null` if the arg is not an arm.
 *
 * Silicon has **flat (left-associative, equal) operator precedence**, so a body
 * that is itself a binary expression steals the arm's root: `$Err e => 0 - 1`
 * parses as `(($Err e => 0) - 1)`, a `-` node whose left spine bottoms out at
 * the `=>`.  We descend the left spine collecting the stolen `(operator, right)`
 * pairs, and if we reach a `=>`, rebuild the real body by re-applying them to
 * the `=>`'s right child (innermost first), reproducing the flat left-assoc
 * chain.  A plain `pattern => body` (no binary body) is the zero-steal case.
 */
function extractArm(a: any): { pattern: any; body: any } | null {
    if (a == null || a.type !== 'BinaryOp') return null
    const stolen: { operator: string; right: any }[] = []
    let node = a
    while (node != null && node.type === 'BinaryOp' && node.operator !== '=>') {
        stolen.push({ operator: node.operator, right: node.right })
        node = node.left
    }
    if (node == null || node.type !== 'BinaryOp' || node.operator !== '=>') return null
    let body = node.right
    for (let i = stolen.length - 1; i >= 0; i--) {
        body = { type: 'BinaryOp', operator: stolen[i].operator, left: body, right: stolen[i].right, sourceLocation: a.sourceLocation }
    }
    return { pattern: node.left, body }
}

/** Collect `|`-chained patterns into a flat list.  `$A | $B | $C` → [$A, $B, $C]. */
function collectAltPatterns(node: any): any[] {
    if (node != null && node.type === 'BinaryOp' && node.operator === '|') {
        return [...collectAltPatterns(node.left), ...collectAltPatterns(node.right)]
    }
    return [node]
}
