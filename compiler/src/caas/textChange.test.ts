// SPDX-License-Identifier: MIT
import { describe, test, expect } from 'bun:test'
import { applyTextChanges } from './textChange'
import { parse } from './index'
import type { TextChange } from './textChange'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function range(startLine: number, startCol: number, endLine: number, endCol: number) {
    return { startLine, startCol, endLine, endCol }
}

function change(startLine: number, startCol: number, endLine: number, endCol: number, newText: string): TextChange {
    return { range: range(startLine, startCol, endLine, endCol), newText }
}

// ---------------------------------------------------------------------------
// applyTextChanges — single-line edits
// ---------------------------------------------------------------------------

describe('applyTextChanges — single-line', () => {
    test('no changes returns source unchanged', () => {
        expect(applyTextChanges('hello world', [])).toBe('hello world')
    })

    test('replace word on a single line', () => {
        // 'hello world' → 'hello there'  (cols 7-12, exclusive end)
        const result = applyTextChanges('hello world', [change(1, 7, 1, 12, 'there')])
        expect(result).toBe('hello there')
    })

    test('pure insertion (empty range)', () => {
        // Insert 'X' at col 6 in 'hello world'
        const result = applyTextChanges('hello world', [change(1, 6, 1, 6, 'X')])
        expect(result).toBe('helloX world')
    })

    test('deletion (empty newText)', () => {
        // Delete 'world' (cols 7-12)
        const result = applyTextChanges('hello world', [change(1, 7, 1, 12, '')])
        expect(result).toBe('hello ')
    })

    test('replace entire line content', () => {
        const result = applyTextChanges('abc', [change(1, 1, 1, 4, 'xyz')])
        expect(result).toBe('xyz')
    })

    test('multiple non-overlapping changes applied correctly', () => {
        // 'foo bar baz'
        // Replace 'foo' (1,1-4) with 'AAA' and 'baz' (1,9-12) with 'ZZZ'
        const src = 'foo bar baz'
        const result = applyTextChanges(src, [
            change(1, 1, 1, 4, 'AAA'),
            change(1, 9, 1, 12, 'ZZZ'),
        ])
        expect(result).toBe('AAA bar ZZZ')
    })

    test('multiple changes can be given in any order', () => {
        const src = 'foo bar baz'
        // Same as above but changes given in reverse order
        const result = applyTextChanges(src, [
            change(1, 9, 1, 12, 'ZZZ'),
            change(1, 1, 1, 4, 'AAA'),
        ])
        expect(result).toBe('AAA bar ZZZ')
    })
})

// ---------------------------------------------------------------------------
// applyTextChanges — multi-line edits
// ---------------------------------------------------------------------------

describe('applyTextChanges — multi-line', () => {
    const SRC = 'line one\nline two\nline three'
    //           123456789  123456789  1234567890

    test('replace text spanning two lines', () => {
        // Replace 'one\nline' (1,6 – 2,5) with 'ONE\nLINE'
        const result = applyTextChanges(SRC, [change(1, 6, 2, 5, 'ONE\nLINE')])
        expect(result).toBe('line ONE\nLINE two\nline three')
    })

    test('delete across a newline', () => {
        // Delete from end of line 1 through start of line 2 (the newline + 'line ')
        // 'line one\nline two' → 'line onetwo'
        const result = applyTextChanges(SRC, [change(1, 9, 2, 6, '')])
        expect(result).toBe('line onetwo\nline three')
    })

    test('insert a new line between existing lines', () => {
        // Insert '\nnew line' at start of line 2 (before 'line two')
        const result = applyTextChanges(SRC, [change(2, 1, 2, 1, 'inserted\n')])
        expect(result).toBe('line one\ninserted\nline two\nline three')
    })

    test('replace all three lines at once', () => {
        const result = applyTextChanges(SRC, [change(1, 1, 3, 11, 'replaced')])
        expect(result).toBe('replaced')
    })

    test('multiple multi-line changes applied correctly', () => {
        // Modify line 1 and line 3 independently
        const result = applyTextChanges(SRC, [
            change(1, 6, 1, 9, 'ONE'),   // 'one' → 'ONE' on line 1
            change(3, 6, 3, 11, 'THREE'), // 'three' → 'THREE' on line 3
        ])
        expect(result).toBe('line ONE\nline two\nline THREE')
    })
})

// ---------------------------------------------------------------------------
// applyTextChanges — error cases
// ---------------------------------------------------------------------------

describe('applyTextChanges — errors', () => {
    test('throws on overlapping changes', () => {
        const src = 'hello world'
        expect(() =>
            applyTextChanges(src, [
                change(1, 1, 1, 6, 'AAA'),
                change(1, 3, 1, 8, 'BBB'), // overlaps with first
            ])
        ).toThrow('overlapping')
    })

    test('adjacent changes (touching but not overlapping) are accepted', () => {
        // 'hello world' — replace 'hello' (1,1-6) and ' world' (1,6-12)
        const result = applyTextChanges('hello world', [
            change(1, 1, 1, 6, 'HI'),
            change(1, 6, 1, 12, ' THERE'),
        ])
        expect(result).toBe('HI THERE')
    })
})

// ---------------------------------------------------------------------------
// SyntaxTree.withChanges
// ---------------------------------------------------------------------------

describe('SyntaxTree.withChanges', () => {
    test('returns a ParseResult', () => {
        const { tree } = parse('@let x := 42;')
        const result = tree.withChanges([change(1, 11, 1, 13, '99')])
        expect(result).toHaveProperty('tree')
        expect(result).toHaveProperty('diagnostics')
    })

    test('the new tree reflects the applied changes', () => {
        const { tree } = parse('@let x := 42;')
        // Replace '42' with '99'
        const { tree: newTree } = tree.withChanges([change(1, 11, 1, 13, '99')])
        expect(newTree.source).toBe('@let x := 99;')
    })

    test('preserves the file name from the original tree', () => {
        const { tree } = parse('@let x := 42;', { file: 'src/main.si' })
        const { tree: newTree } = tree.withChanges([change(1, 11, 1, 13, '99')])
        expect(newTree.file).toBe('src/main.si')
    })

    test('original tree is not mutated', () => {
        const { tree } = parse('@let x := 42;')
        tree.withChanges([change(1, 11, 1, 13, '99')])
        expect(tree.source).toBe('@let x := 42;')
    })

    test('empty changes returns a tree with the same source text', () => {
        const { tree } = parse('@let x := 42;')
        const { tree: newTree } = tree.withChanges([])
        expect(newTree.source).toBe(tree.source)
    })

    test('multi-line change produces a valid parse result', () => {
        const src = '@fn answer := { 42 };\n@let r := &answer;'
        const { tree } = parse(src)
        // Replace the entire second line with a new let binding
        const { tree: newTree, diagnostics } = tree.withChanges([
            change(2, 1, 2, src.split('\n')[1].length + 1, '@let s := &answer;'),
        ])
        expect(diagnostics).toHaveLength(0)
        expect(newTree.source).toContain('@let s := &answer;')
    })

    test('throws on overlapping changes (propagated from applyTextChanges)', () => {
        const { tree } = parse('@let x := 42;')
        expect(() =>
            tree.withChanges([
                change(1, 1, 1, 5, 'AAA'),
                change(1, 3, 1, 8, 'BBB'),
            ])
        ).toThrow('overlapping')
    })
})
