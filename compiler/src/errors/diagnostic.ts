// SPDX-License-Identifier: MIT
/**
 * Structured diagnostics — WS 4 of Stage 0 Cleanup Plan.
 *
 * Stage 1 will render these (with carets, color, "did you mean…", etc.); Stage 0
 * just emits the records.  Per the cleanup plan: source spans are infrastructure
 * and painful to retrofit later, but pretty rendering is throwaway, so we land
 * the records now and skip the rendering polish.
 *
 * Authoritative shape — every new error site SHOULD emit a Diagnostic instead
 * of a bare string.  The existing TypeError type stays for the type-checker's
 * internal use; `toDiagnostic` lifts it into the unified record.
 */

import type { SourceLocation } from '../ast/astNodes'
import type { TypeError, TypeErrorKind } from '../types/errors'

// ─────────────────────────────────────────────────────────────────────────────
// Record shape
// ─────────────────────────────────────────────────────────────────────────────

export type Phase = 'parse' | 'elaborate' | 'typecheck' | 'lower' | 'emit'

export interface SourceSpan {
    /** File the source came from.  Empty string when unknown (synthesised nodes). */
    file: string
    line: number
    col: number
    /** Byte length the diagnostic covers.  0 when the span is a point. */
    length: number
}

export interface Diagnostic {
    /** Pipeline phase that produced the diagnostic. */
    phase: Phase
    /** Stable identifier (E0001 …).  Matched by tests; never reuse a number. */
    code: string
    /** Where in source the diagnostic points.  May be a point span. */
    span: SourceSpan
    /** Short human-readable message.  No leading "Error:" — render layer adds. */
    message: string
    /** Optional secondary advice ("did you mean …", "available choices: …"). */
    hint?: string
    /** Optional related notes — already-formatted Diagnostic records. */
    notes?: Diagnostic[]
    /**
     * Optional verbatim source line for caret rendering.  When present,
     * `renderPretty` will emit the snippet and a `^` underline below the
     * message, Rust-style.  Set by the pipeline at the point closest to the
     * source text (parser or semantic model lookup).
     */
    snippet?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostic-code registry — every code is documented exactly once here so
// it shows up in `docs/diagnostics.md` (forthcoming) and matchers stay stable.
// ─────────────────────────────────────────────────────────────────────────────

/** Map from TypeErrorKind to the stable code that should be reported. */
export const TYPE_ERROR_CODES: Record<TypeErrorKind, string> = {
    UnknownType:           'E0001',  // type annotation referenced an unrecognised name
    Mismatch:              'E0002',  // expected type X, got type Y
    InvalidOperator:       'E0003',  // operator not defined for these operand types
    UnboundIdentifier:     'E0004',  // reference to an unknown identifier
    HeterogeneousArray:    'E0005',  // array literal elements do not share a type
    Annotation:            'E0006',  // initializer doesn't match declared annotation
    ImmutableAssignment:   'E0007',  // assignment to an immutable binding
    MissingReturn:         'E0008',  // non-void function body may not produce a value
    ArityMismatch:         'E0009',  // wrong number of arguments at call site
    // E0010 = lower-time `@move_to_parent_arena` outside tail position (Phase 9c).
    // E0011 = lower-time nested-heap promotion rejected (Phase 9c).
    MvpOnlyIntrospection:  'E0012',  // wasm-mvp-only introspection primitive under wasm-gc (Phase 9d-5a)
    MvpOnlyPhysicalByte:   'E0013',  // wasm-mvp-only raw-memory primitive under wasm-gc (Phase 9d-5b)
    GlobalInFunction:      'E0014',  // @global used inside a function body (use @local)
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversion helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Wrap an AST SourceLocation into a SourceSpan (with optional file path). */
export function spanFromLocation(loc: SourceLocation | undefined, file = ''): SourceSpan {
    if (!loc) return { file, line: 0, col: 0, length: 0 }
    const length = loc.endLine === loc.startLine
        ? Math.max(0, loc.endColumn - loc.startColumn)
        : 0  // multi-line spans collapse to length 0 — render layer reads endLine/endColumn separately
    return { file, line: loc.startLine, col: loc.startColumn, length }
}

/** Lift a TypeError into a Diagnostic in the typecheck phase. */
export function toDiagnostic(err: TypeError, file = ''): Diagnostic {
    const d: Diagnostic = {
        phase: 'typecheck',
        code: TYPE_ERROR_CODES[err.kind],
        span: spanFromLocation(err.sourceLocation, file),
        message: err.message,
    }
    if (err.hint) d.hint = err.hint
    return d
}

/** Lift a parse error (Error instance from parser.ts) into a Diagnostic. */
export function parseDiagnostic(err: Error, file = ''): Diagnostic {
    // parser.ts throws `Parse error: Line N, col M: <message>`.  Extract span.
    const match = err.message.match(/Line\s+(\d+),\s+col\s+(\d+)/)
    const line = match ? Number(match[1]) : 0
    const col  = match ? Number(match[2]) : 0
    return {
        phase: 'parse',
        code: 'E0100',
        span: { file, line, col, length: 0 },
        message: err.message.replace(/^Parse error:\s*/, ''),
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// "Did you mean" — Levenshtein-based nearest-name suggestions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classic Levenshtein edit distance.  O(m·n) time, O(n) space.
 * Returns the minimum number of single-character edits (insert, delete,
 * substitute) to transform `a` into `b`.
 */
export function levenshtein(a: string, b: string): number {
    const m = a.length
    const n = b.length
    // row[j] = distance from a[0..i] to b[0..j] — updated in-place
    const row: number[] = Array.from({ length: n + 1 }, (_, j) => j)
    for (let i = 1; i <= m; i++) {
        let prev = i
        for (let j = 1; j <= n; j++) {
            const next = a[i - 1] === b[j - 1]
                ? row[j - 1]
                : 1 + Math.min(row[j - 1], prev, row[j])
            row[j - 1] = prev
            prev = next
        }
        row[n] = prev
    }
    return row[n]
}

/**
 * Return the element of `candidates` closest to `query` by Levenshtein
 * distance, or `undefined` if `candidates` is empty or the closest match is
 * more than `maxDist` edits away (default 3).
 */
export function closest(query: string, candidates: string[], maxDist = 3): string | undefined {
    let best: string | undefined
    let bestDist = maxDist + 1
    for (const c of candidates) {
        const d = levenshtein(query, c)
        if (d < bestDist) {
            bestDist = d
            best = c
        }
    }
    return bestDist <= maxDist ? best : undefined
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

/** Render a list of diagnostics as a JSON array (the CLI default). */
export function renderJson(diags: Diagnostic[]): string {
    return JSON.stringify(diags, null, 2)
}

/** Disposable pretty renderer.  Throwaway in Stage 1 — keep it tight. */
export function renderPretty(diags: Diagnostic[]): string {
    return diags.map(d => {
        const where = d.span.line > 0
            ? `${d.span.file || '<input>'}:${d.span.line}:${d.span.col}`
            : '<unknown>'
        const head = `${d.code} [${d.phase}] ${where}: ${d.message}`
        let caret = ''
        if (d.snippet) {
            const col = Math.max(0, d.span.col - 1)  // convert to 0-based
            const len = Math.max(1, d.span.length)
            const underline = ' '.repeat(col) + '^'.repeat(len)
            caret = `\n  ${d.snippet}\n  ${underline}`
        }
        const hint = d.hint ? `\n  hint: ${d.hint}` : ''
        const notes = d.notes && d.notes.length > 0
            ? '\n' + d.notes.map(n => `  note ${n.code}: ${n.message}`).join('\n')
            : ''
        return head + caret + hint + notes
    }).join('\n')
}
