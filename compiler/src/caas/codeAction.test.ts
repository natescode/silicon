// SPDX-License-Identifier: MIT

import { describe, test, expect, beforeEach } from 'bun:test'
import {
    type CodeAction,
    type CodeActionProvider,
    type TextEdit,
    registerCodeAction,
    getCodeActions,
    clearCodeActions,
    applyEdits,
    E0004_renameProvider,
} from './codeAction'
import type { Diagnostic } from '../errors/diagnostic'

function span(line: number, col: number, length: number, file = 'test.si') {
    return { file, line, col, length }
}

describe('CaaS-11 — CodeAction registry', () => {
    beforeEach(() => {
        // Wipe + re-register built-ins so each test starts clean.
        clearCodeActions()
        registerCodeAction('E0004', E0004_renameProvider)
    })

    test('registerCodeAction + getCodeActions: round-trip', () => {
        clearCodeActions()
        const provider: CodeActionProvider = (d) => [{
            title: 'demo',
            kind: 'quickfix',
            edits: [],
            diagnostics: [d],
        }]
        registerCodeAction('E0999', provider)

        const diag: Diagnostic = {
            phase: 'typecheck', code: 'E0999', span: span(1, 1, 0), message: 'demo',
        }
        const actions = getCodeActions(diag, 'source')
        expect(actions.length).toBe(1)
        expect(actions[0].title).toBe('demo')
    })

    test('multiple providers concatenate; duplicates dedup by title', () => {
        clearCodeActions()
        registerCodeAction('E0999', () => [{ title: 'a', kind: 'quickfix', edits: [], diagnostics: [] }])
        registerCodeAction('E0999', () => [
            { title: 'a', kind: 'quickfix', edits: [], diagnostics: [] }, // dup
            { title: 'b', kind: 'quickfix', edits: [], diagnostics: [] },
        ])
        const diag: Diagnostic = { phase: 'typecheck', code: 'E0999', span: span(1, 1, 0), message: '' }
        const actions = getCodeActions(diag, '')
        expect(actions.map(a => a.title)).toEqual(['a', 'b'])
    })

    test('unknown diagnostic code returns []', () => {
        const diag: Diagnostic = { phase: 'typecheck', code: 'E9999', span: span(1, 1, 0), message: '' }
        expect(getCodeActions(diag, '')).toEqual([])
    })

    test('E0004 built-in: hint with suggestion → rename quickfix', () => {
        const source = 'let nme = 1\n'
        const diag: Diagnostic = {
            phase: 'elaborate',
            code: 'E0004',
            span: span(1, 5, 3),
            message: "Unknown identifier 'nme'",
            hint: "did you mean 'name'?",
        }
        const actions = getCodeActions(diag, source)
        expect(actions.length).toBe(1)
        expect(actions[0].title).toBe("Rename to 'name'")
        expect(actions[0].kind).toBe('quickfix')
        expect(actions[0].isPreferred).toBe(true)
        expect(actions[0].edits.length).toBe(1)
        expect(actions[0].edits[0].newText).toBe('name')
    })

    test('E0004 without a hint → no action', () => {
        const diag: Diagnostic = {
            phase: 'elaborate', code: 'E0004', span: span(1, 1, 1), message: '',
        }
        expect(getCodeActions(diag, '')).toEqual([])
    })
})

describe('CaaS-11 — applyEdits', () => {
    test('single replace', () => {
        const source = 'let foo = 1\n'
        const edits: TextEdit[] = [{ span: span(1, 5, 3), newText: 'bar' }]
        expect(applyEdits(source, edits)).toBe('let bar = 1\n')
    })

    test('multiple non-overlapping edits apply correctly', () => {
        const source = 'let foo = 1\nlet bar = 2\n'
        const edits: TextEdit[] = [
            { span: span(1, 5, 3), newText: 'aaa' },
            { span: span(2, 5, 3), newText: 'bbb' },
        ]
        expect(applyEdits(source, edits)).toBe('let aaa = 1\nlet bbb = 2\n')
    })

    test('insertion (length-0 span)', () => {
        const source = 'fn x()\n'
        const edits: TextEdit[] = [{ span: span(1, 7, 0), newText: ': Int' }]
        expect(applyEdits(source, edits)).toBe('fn x(): Int\n')
    })

    test('empty edit list returns source unchanged', () => {
        const source = 'untouched\n'
        expect(applyEdits(source, [])).toBe(source)
    })

    test('overlapping edits throw', () => {
        const source = 'abcdef\n'
        const edits: TextEdit[] = [
            { span: span(1, 1, 3), newText: 'X' },  // [0,3)
            { span: span(1, 2, 3), newText: 'Y' },  // [1,4) overlaps
        ]
        expect(() => applyEdits(source, edits)).toThrow(/overlapping/)
    })
})
