// SPDX-License-Identifier: MIT
/**
 * TextChange — range-based incremental text edits.
 *
 * Complements `TextEdit` (used by code actions) with multi-line support.
 * `TextEdit` uses a `SourceSpan` (single-line, `line/col/length`); `TextChange`
 * uses a `SourceRange` (start + end line/col) so it can span line boundaries —
 * the shape LSP `textDocument/didChange` sends.
 *
 * Entry points:
 *   - `applyTextChanges(source, changes)` — apply edits to a string
 *   - `SyntaxTree.withChanges(changes)`   — apply + reparse in one call
 *
 * @public — Silicon 1.0 stable.
 */

import type { SourceRange } from '../ast/semanticModel'

export type { SourceRange }

// ---------------------------------------------------------------------------
// TextChange
// ---------------------------------------------------------------------------

/**
 * Replace the text in `range` with `newText`.
 *
 * `range` coordinates are 1-based; `endLine`/`endCol` are exclusive
 * (matching LSP and `SourceRange` convention).
 *
 * Special cases:
 *   - `startLine === endLine && startCol === endCol` — pure insertion
 *   - `newText === ''` — deletion
 *
 * @public
 */
export interface TextChange {
    readonly range: SourceRange
    readonly newText: string
}

// ---------------------------------------------------------------------------
// Offset helpers
// ---------------------------------------------------------------------------

/**
 * Build a line-start offset table for `source` (0-indexed array; entry `i` is
 * the byte offset of the first character on 1-based line `i + 1`).
 */
function lineStartOffsets(source: string): number[] {
    const offsets: number[] = [0]
    for (let i = 0; i < source.length; i++) {
        if (source[i] === '\n') offsets.push(i + 1)
    }
    return offsets
}

/**
 * Convert a 1-based `SourceRange` to a half-open `[start, end)` byte-offset pair
 * into `source`.  `endCol` is exclusive (matching `SourceRange` convention), so
 * the result maps directly to a `String.slice` boundary.
 *
 * Shared with the incremental parser (`incremental.ts`) so that text edits and
 * damage-region computation agree on coordinates.
 *
 * @public
 */
export function rangeToOffsets(source: string, range: SourceRange): { start: number; end: number } {
    const lineOffsets = lineStartOffsets(source)
    const toOffset = (line: number, col: number): number =>
        (lineOffsets[line - 1] ?? source.length) + (col - 1)
    return {
        start: toOffset(range.startLine, range.startCol),
        end:   toOffset(range.endLine,   range.endCol),
    }
}

// ---------------------------------------------------------------------------
// applyTextChanges
// ---------------------------------------------------------------------------

/**
 * Apply a set of `TextChange`s to `source` and return the rewritten string.
 *
 * Changes are applied bottom-up (sorted by descending start offset) so that
 * applying one change does not shift the offsets of later ones.
 *
 * Throws if any two changes have overlapping ranges.  Returns `source`
 * unchanged when `changes` is empty.
 *
 * @public
 */
export function applyTextChanges(source: string, changes: readonly TextChange[]): string {
    if (changes.length === 0) return source

    // Flatten to (start, end, newText) where both ends are byte offsets.
    const flat = changes.map((c, i) => {
        const { start, end } = rangeToOffsets(source, c.range)
        return { start, end, text: c.newText, idx: i }   // idx kept for error messages
    })

    // Sort descending by start so applying one edit doesn't shift the rest.
    flat.sort((a, b) => b.start - a.start || b.end - a.end)

    // Reject overlapping changes — two ranges whose [start, end) intersect.
    for (let i = 0; i < flat.length - 1; i++) {
        const hi = flat[i]
        const lo = flat[i + 1]
        if (lo.end > hi.start) {
            throw new Error(
                `applyTextChanges: overlapping changes — ` +
                `change ${lo.idx} [${lo.start},${lo.end}) overlaps change ${hi.idx} [${hi.start},${hi.end})`
            )
        }
    }

    let out = source
    for (const c of flat) {
        out = out.slice(0, c.start) + c.text + out.slice(c.end)
    }
    return out
}
