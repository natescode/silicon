/**
 * Unit tests for the structured-diagnostic surface — WS 4 of Stage 0 Cleanup.
 */

import { test, expect, describe } from 'bun:test'
import {
    TYPE_ERROR_CODES,
    spanFromLocation,
    toDiagnostic,
    parseDiagnostic,
    renderJson,
    renderPretty,
    type Diagnostic,
} from './diagnostic'
import type { TypeError } from '../types/errors'

describe('TYPE_ERROR_CODES', () => {
    test('every TypeErrorKind has a stable code', () => {
        // If a new kind is added, this test catches the missing code wiring.
        const expectedKinds = [
            'UnknownType', 'Mismatch', 'InvalidOperator',
            'UnboundIdentifier', 'HeterogeneousArray',
            'Annotation', 'ImmutableAssignment',
        ] as const
        for (const k of expectedKinds) {
            expect(TYPE_ERROR_CODES[k]).toMatch(/^E\d{4}$/)
        }
    })

    test('codes are unique', () => {
        const codes = Object.values(TYPE_ERROR_CODES)
        expect(new Set(codes).size).toBe(codes.length)
    })
})

describe('spanFromLocation', () => {
    test('undefined location collapses to a point span', () => {
        const span = spanFromLocation(undefined, 'main.si')
        expect(span).toEqual({ file: 'main.si', line: 0, col: 0, length: 0 })
    })

    test('single-line location yields a span with byte length', () => {
        const span = spanFromLocation(
            { startLine: 3, startColumn: 4, endLine: 3, endColumn: 10 },
            'main.si',
        )
        expect(span).toEqual({ file: 'main.si', line: 3, col: 4, length: 6 })
    })

    test('multi-line locations collapse length to 0 (render layer decides)', () => {
        const span = spanFromLocation(
            { startLine: 3, startColumn: 4, endLine: 7, endColumn: 1 },
            'main.si',
        )
        expect(span).toEqual({ file: 'main.si', line: 3, col: 4, length: 0 })
    })
})

describe('toDiagnostic', () => {
    test('lifts a TypeError into a Diagnostic preserving message and span', () => {
        const err: TypeError = {
            kind: 'Mismatch',
            message: 'expected Int, got Float',
            sourceLocation: { startLine: 1, startColumn: 5, endLine: 1, endColumn: 12 },
        }
        const d = toDiagnostic(err, 'main.si')
        expect(d.phase).toBe('typecheck')
        expect(d.code).toBe(TYPE_ERROR_CODES['Mismatch'])
        expect(d.span).toEqual({ file: 'main.si', line: 1, col: 5, length: 7 })
        expect(d.message).toBe('expected Int, got Float')
    })

    test('missing source location yields a point span', () => {
        const err: TypeError = { kind: 'UnboundIdentifier', message: "unbound 'x'" }
        const d = toDiagnostic(err)
        expect(d.span).toEqual({ file: '', line: 0, col: 0, length: 0 })
    })
})

describe('parseDiagnostic', () => {
    test('extracts line/col from parser.ts error message', () => {
        const err = new Error('Parse error: Line 7, col 3:\n  > foo\nExpected ";"')
        const d = parseDiagnostic(err, 'main.si')
        expect(d.phase).toBe('parse')
        expect(d.code).toBe('E0100')
        expect(d.span.line).toBe(7)
        expect(d.span.col).toBe(3)
        expect(d.message).not.toMatch(/^Parse error:/)
    })

    test('missing location yields a point span at 0:0', () => {
        const err = new Error('something went wrong')
        const d = parseDiagnostic(err)
        expect(d.span.line).toBe(0)
        expect(d.span.col).toBe(0)
    })
})

describe('renderJson', () => {
    test('produces parseable JSON', () => {
        const diags: Diagnostic[] = [
            { phase: 'parse', code: 'E0100', span: { file: 'main.si', line: 1, col: 1, length: 0 }, message: 'oops' },
        ]
        const parsed = JSON.parse(renderJson(diags))
        expect(parsed).toEqual(diags as any)
    })
})

describe('renderPretty', () => {
    test('formats a diagnostic with code, phase, span and message', () => {
        const d: Diagnostic = {
            phase: 'typecheck',
            code: 'E0002',
            span: { file: 'main.si', line: 3, col: 5, length: 4 },
            message: 'expected Int, got Float',
        }
        const out = renderPretty([d])
        expect(out).toContain('E0002')
        expect(out).toContain('typecheck')
        expect(out).toContain('main.si:3:5')
        expect(out).toContain('expected Int, got Float')
    })

    test('hint appears on its own line when present', () => {
        const d: Diagnostic = {
            phase: 'typecheck',
            code: 'E0004',
            span: { file: '', line: 1, col: 1, length: 0 },
            message: "unbound 'foo'",
            hint: 'did you mean foo_helper?',
        }
        const out = renderPretty([d])
        expect(out).toContain('hint: did you mean foo_helper?')
    })

    test('falls back to <input> when file is empty', () => {
        const d: Diagnostic = {
            phase: 'lower',
            code: 'E0200',
            span: { file: '', line: 5, col: 2, length: 0 },
            message: 'irk',
        }
        expect(renderPretty([d])).toContain('<input>:5:2')
    })

    test('falls back to <unknown> when line is 0', () => {
        const d: Diagnostic = {
            phase: 'lower',
            code: 'E0200',
            span: { file: 'main.si', line: 0, col: 0, length: 0 },
            message: 'irk',
        }
        expect(renderPretty([d])).toContain('<unknown>')
    })
})
