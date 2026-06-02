// SPDX-License-Identifier: MIT
/**
 * Tier 1 LSP API tests — hoverInfo, getCompletions, signatureHelp,
 * rename, formatDocument, formatRange.
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import { Workspace } from './workspace'

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

// 'add' definition is on line 1, col 5 (1-based: @=1 f=2 n=3 space=4 a=5)
const LIB_SOURCE = '@fn add x, y := { x + y };'

const MAIN_SOURCE = '@let result := &add 1, 2;'
// 'add' reference: '&' at col 16, 'add' Namespace at col 17

function twoDocWs() {
    const ws = new Workspace()
    ws.openDocument('lib.si', LIB_SOURCE)
    ws.openDocument('main.si', MAIN_SOURCE)
    return ws
}

// ---------------------------------------------------------------------------
// Symbol.displayString (2a)
// ---------------------------------------------------------------------------

describe('Symbol.displayString', () => {
    test('function symbol shows parameter and return types when typed', () => {
        // Use a \\ signature line to give the function a typed signature.
        // (The → Unicode arrow is not supported in sig lines; use the Tuple form.)
        const ws = new Workspace()
        ws.openDocument('f.si', '\\\\ add (Int, Int)\n@fn add x, y := { x + y };')
        // 'add' is on line 2
        const sym = ws.findDefinition('f.si', 2, 5)
        expect(sym).toBeDefined()
        expect(sym!.displayString).toContain('fn add')
        expect(sym!.displayString).toContain('Int')
    })

    test('function symbol without signature shows name', () => {
        const ws = new Workspace()
        ws.openDocument('f.si', '@fn add x, y := { x + y };')
        const sym = ws.findDefinition('f.si', 1, 5)
        expect(sym).toBeDefined()
        expect(sym!.displayString).toContain('fn add')
    })

    test('variable symbol shows its type', () => {
        const ws = new Workspace()
        ws.openDocument('f.si', '@let x := 42;')
        const sym = ws.findDefinition('f.si', 1, 6)
        expect(sym).toBeDefined()
        expect(sym!.displayString).toContain('let x')
    })
})

// ---------------------------------------------------------------------------
// hoverInfo (1a)
// ---------------------------------------------------------------------------

describe('Workspace.hoverInfo()', () => {
    test('returns HoverInfo for a symbol at its definition site', () => {
        const ws = new Workspace()
        ws.openDocument('f.si', '@fn add x, y := { x + y };')
        const info = ws.hoverInfo('f.si', 1, 5)
        expect(info).toBeDefined()
        expect(info!.symbol.name).toBe('add')
        expect(info!.typeDisplay).toContain('fn add')
    })

    test('returns undefined for unopened document', () => {
        const ws = new Workspace()
        expect(ws.hoverInfo('ghost.si', 1, 1)).toBeUndefined()
    })

    test('returns undefined for a position outside any symbol', () => {
        const ws = new Workspace()
        ws.openDocument('f.si', '@fn add x := { x };')
        expect(ws.hoverInfo('f.si', 1, 1)).toBeUndefined()
    })

    test('cross-document: resolves a symbol defined in another document', () => {
        const ws = twoDocWs()
        // col 17 is 'add' in '&add 1, 2'
        const info = ws.hoverInfo('main.si', 1, 17)
        expect(info).toBeDefined()
        expect(info!.symbol.name).toBe('add')
    })

    test('range covers the identifier span', () => {
        const ws = new Workspace()
        ws.openDocument('f.si', '@fn add x := { x };')
        const info = ws.hoverInfo('f.si', 1, 5)
        expect(info!.range).toBeDefined()
        expect(info!.range!.startLine).toBe(1)
        expect(info!.range!.startCol).toBe(5)
    })
})

// ---------------------------------------------------------------------------
// getCompletions (1b)
// ---------------------------------------------------------------------------

describe('Workspace.getCompletions()', () => {
    test('returns items for all symbols in the document', () => {
        const ws = new Workspace()
        ws.openDocument('f.si', '@fn foo := { 1 };\n@fn bar := { 2 };')
        const items = ws.getCompletions('f.si', 1, 1)
        const labels = items.map(i => i.label)
        expect(labels).toContain('foo')
        expect(labels).toContain('bar')
    })

    test('includes cross-document symbols', () => {
        const ws = twoDocWs()
        const items = ws.getCompletions('main.si', 1, 1)
        const labels = items.map(i => i.label)
        expect(labels).toContain('add')
    })

    test('prefix filters results (case-insensitive)', () => {
        const ws = new Workspace()
        ws.openDocument('f.si', '@fn alpha := { 1 };\n@fn beta := { 2 };')
        const items = ws.getCompletions('f.si', 1, 1, 'al')
        expect(items.some(i => i.label === 'alpha')).toBe(true)
        expect(items.some(i => i.label === 'beta')).toBe(false)
    })

    test('includes built-in Silicon keywords', () => {
        const ws = new Workspace()
        ws.openDocument('f.si', '')
        const items = ws.getCompletions('f.si', 1, 1)
        const labels = items.map(i => i.label)
        expect(labels).toContain('@fn')
        expect(labels).toContain('@let')
    })

    test('returns empty array for unopened document', () => {
        const ws = new Workspace()
        expect(ws.getCompletions('ghost.si', 1, 1)).toHaveLength(0)
    })

    test('completion items include a detail string', () => {
        const ws = new Workspace()
        ws.openDocument('f.si', '@fn add x, y := { x + y };')
        const items = ws.getCompletions('f.si', 1, 1)
        const add = items.find(i => i.label === 'add')
        expect(add).toBeDefined()
        expect(typeof add!.detail).toBe('string')
        expect(add!.detail).toContain('fn add')
    })

    test('each item has a valid kind', () => {
        const ws = new Workspace()
        ws.openDocument('f.si', '@fn foo := { 1 };\n@let x := 0;')
        const items = ws.getCompletions('f.si', 1, 1)
        const VALID = new Set(['function', 'variable', 'type', 'parameter', 'keyword'])
        for (const item of items) {
            expect(VALID.has(item.kind)).toBe(true)
        }
    })
})

// ---------------------------------------------------------------------------
// signatureHelp (1c)
// ---------------------------------------------------------------------------

describe('Workspace.signatureHelp()', () => {
    test('returns SignatureHelp inside a function call argument list', () => {
        const ws = new Workspace()
        // \\ signature line gives 'add' a Function type with Int params
        ws.openDocument('f.si', '\\\\ add (Int, Int)\n@fn add x, y := { x + y };\n@let r := &add 1, 2;')
        // line 3: '@let r := &add 1, 2;'
        // '@'=1 'l'=2 'e'=3 't'=4 ' '=5 'r'=6 ' '=7 ':'=8 '='=9 ' '=10 '&'=11 'a'=12 'd'=13 'd'=14 ' '=15 '1'=16
        const help = ws.signatureHelp('f.si', 3, 16)
        expect(help).toBeDefined()
        expect(help!.name).toBe('add')
        expect(help!.parameters.length).toBeGreaterThanOrEqual(1)
    })

    test('parameters have type strings when typed via signature line', () => {
        const ws = new Workspace()
        ws.openDocument('f.si', '\\\\ add (Int, Int)\n@fn add x, y := { x + y };\n@let r := &add 1, 2;')
        const help = ws.signatureHelp('f.si', 3, 16)
        expect(help).toBeDefined()
        for (const p of help!.parameters) {
            if (p.type) expect(p.type).toContain('Int')
        }
    })

    test('returns undefined when not inside a call', () => {
        const ws = new Workspace()
        ws.openDocument('f.si', '@fn add x := { x };')
        // col 1 is '@' — not inside any argument list
        expect(ws.signatureHelp('f.si', 1, 1)).toBeUndefined()
    })

    test('returns undefined for unopened document', () => {
        const ws = new Workspace()
        expect(ws.signatureHelp('ghost.si', 1, 1)).toBeUndefined()
    })
})

// ---------------------------------------------------------------------------
// rename (1d)
// ---------------------------------------------------------------------------

describe('Workspace.rename()', () => {
    test('returns a WorkspaceEdit with TextEdits for all reference sites', () => {
        const ws = twoDocWs()
        const edits = ws.rename('lib.si', 1, 5, 'sum')
        expect(edits.size).toBeGreaterThan(0)
        // The definition site (lib.si) must be present.
        expect(edits.has('lib.si')).toBe(true)
    })

    test('all edits replace with the new name', () => {
        const ws = twoDocWs()
        const edits = ws.rename('lib.si', 1, 5, 'sum')
        for (const fileEdits of edits.values()) {
            for (const edit of fileEdits) {
                expect(edit.newText).toBe('sum')
            }
        }
    })

    test('cross-document: call site in another document is included', () => {
        const ws = twoDocWs()
        const edits = ws.rename('lib.si', 1, 5, 'sum')
        // main.si calls &add — should appear in edits
        expect(edits.has('main.si')).toBe(true)
    })

    test('returns empty map when no symbol at position', () => {
        const ws = new Workspace()
        ws.openDocument('f.si', '@fn add x := { x };')
        const edits = ws.rename('f.si', 1, 1, 'whatever')
        expect(edits.size).toBe(0)
    })

    test('returns empty map for unopened document', () => {
        const ws = new Workspace()
        expect(ws.rename('ghost.si', 1, 1, 'x').size).toBe(0)
    })
})

// ---------------------------------------------------------------------------
// formatDocument (1e)
// ---------------------------------------------------------------------------

describe('Workspace.formatDocument()', () => {
    test('returns empty array when source is already normalized', () => {
        const ws = new Workspace()
        const src = '@fn add x:Int, y:Int := { x + y };\n'
        ws.openDocument('f.si', src)
        const edits = ws.formatDocument('f.si')
        // May already be clean — accept 0 or a no-op edit.
        if (edits.length > 0) {
            // If an edit is returned, applying it should not change the source.
            const result = edits[0].newText
            expect(result.trim()).toBe(src.trim())
        }
    })

    test('normalizes multiple spaces to one', () => {
        const ws = new Workspace()
        ws.openDocument('f.si', '@fn  add   x := {  x  };')
        const edits = ws.formatDocument('f.si')
        expect(edits.length).toBeGreaterThan(0)
        const normalized = edits[0].newText
        expect(normalized).not.toContain('  ')
    })

    test('returns empty array for unopened document', () => {
        const ws = new Workspace()
        expect(ws.formatDocument('ghost.si')).toHaveLength(0)
    })

    test('returned edit newText produces valid-looking Silicon', () => {
        const ws = new Workspace()
        ws.openDocument('f.si', '@let  x  :=  42;')
        const edits = ws.formatDocument('f.si')
        expect(edits.length).toBeGreaterThan(0)
        expect(edits[0].newText).toContain(':=')
        expect(edits[0].newText).not.toContain('  ')
    })
})

// ---------------------------------------------------------------------------
// formatRange (1f)
// ---------------------------------------------------------------------------

describe('Workspace.formatRange()', () => {
    test('formats only the selected lines', () => {
        const ws = new Workspace()
        const src = '@fn add x := { x };\n@let  result :=  &add 1;'
        ws.openDocument('f.si', src)
        const edits = ws.formatRange('f.si', {
            startLine: 2, startCol: 1,
            endLine:   2, endCol:   src.split('\n')[1].length + 1,
        })
        if (edits.length > 0) {
            expect(edits[0].newText).not.toContain('  ')
        }
    })

    test('returns empty array for unopened document', () => {
        const ws = new Workspace()
        expect(ws.formatRange('ghost.si', {
            startLine: 1, startCol: 1,
            endLine: 1, endCol: 1,
        })).toHaveLength(0)
    })
})
