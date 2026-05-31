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
    return rawArgs.slice(1).some(a => isArmExpr(a))
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
        if (isArmExpr(a)) {
            const patterns = collectAltPatterns(a.left)
            for (const pat of patterns) {
                out.push(pat)
                out.push(a.right)
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

function isArmExpr(node: any): boolean {
    return node != null && node.type === 'BinaryOp' && node.operator === '=>'
}

/** Collect `|`-chained patterns into a flat list.  `$A | $B | $C` → [$A, $B, $C]. */
function collectAltPatterns(node: any): any[] {
    if (node != null && node.type === 'BinaryOp' && node.operator === '|') {
        return [...collectAltPatterns(node.left), ...collectAltPatterns(node.right)]
    }
    return [node]
}
