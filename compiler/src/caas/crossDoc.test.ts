// SPDX-License-Identifier: MIT
/**
 * CaaS-5 cross-document navigation tests.
 *
 * These tests exercise Workspace.findDefinition and findReferences when the
 * definition and call sites live in different open documents.
 */
import { describe, test, expect } from 'bun:test'
import { Workspace } from './workspace'

const LIB  = '@fn add x, y := { x + y };'
// 'add' definition: col 5, length 3  (1-based: @=1 f=2 n=3 space=4 a=5)

const MAIN = 'result := add(1, 2);'
// 'add' call: 'add' at col 11

function twoDocWs() {
    const ws = new Workspace()
    ws.openDocument('lib.si',  LIB)
    ws.openDocument('main.si', MAIN)
    return ws
}

// ---------------------------------------------------------------------------
// Symbol index — maintained as documents open / edit / close
// ---------------------------------------------------------------------------

describe('Workspace symbol index', () => {
    test('symbols from all open documents are indexed', () => {
        const ws = twoDocWs()
        // findDefinition succeeds from any document
        const sym = ws.findDefinition('main.si', 1, 11)
        expect(sym).toBeDefined()
        expect(sym!.name).toBe('add')
    })

    test('index entry is removed when document is closed', () => {
        const ws = twoDocWs()
        ws.closeDocument('lib.si')
        const sym = ws.findDefinition('main.si', 1, 11)
        expect(sym).toBeUndefined()
    })

    test('index is updated when document is edited', () => {
        const ws = new Workspace()
        ws.openDocument('lib.si', '@fn foo := { 1 };')
        expect(ws.findDefinition('lib.si', 1, 5)?.name).toBe('foo')

        // Edit renames the function
        ws.editDocument('lib.si', '@fn bar := { 1 };')
        expect(ws.findDefinition('lib.si', 1, 5)?.name).toBe('bar')
        // Old name is gone
        expect(ws.findDefinition('lib.si', 1, 5)?.name).not.toBe('foo')
    })

    test('both definitions are kept when two documents define the same name', () => {
        const ws = new Workspace()
        ws.openDocument('a.si', '@fn add x, y := { x + y };')
        ws.openDocument('b.si', '@fn add a, b := { a + b };')

        // findDefinitions returns both candidates
        const defs = ws.findDefinitions('a.si', 1, 5)
        expect(defs.length).toBe(2)
        expect(defs.every(s => s.name === 'add')).toBe(true)
        const files = new Set(defs.map(s => s.definitionSpan?.file))
        expect(files.has('a.si')).toBe(true)
        expect(files.has('b.si')).toBe(true)
    })

    test('closing one document removes only its entry from a shared name', () => {
        const ws = new Workspace()
        ws.openDocument('a.si', '@fn add x, y := { x + y };')
        ws.openDocument('b.si', '@fn add a, b := { a + b };')
        ws.closeDocument('a.si')

        // 'add' is still reachable through b.si
        const defs = ws.findDefinitions('b.si', 1, 5)
        expect(defs.length).toBe(1)
        expect(defs[0].definitionSpan?.file).toBe('b.si')
    })
})

// ---------------------------------------------------------------------------
// Cross-document findDefinition
// ---------------------------------------------------------------------------

describe('Workspace.findDefinition() — cross-document', () => {
    test('resolves a symbol defined in a different document', () => {
        const ws = twoDocWs()
        const sym = ws.findDefinition('main.si', 1, 11)
        expect(sym).toBeDefined()
        expect(sym!.name).toBe('add')
    })

    test('definitionSpan.file points to the defining document', () => {
        const ws = twoDocWs()
        const sym = ws.findDefinition('main.si', 1, 11)
        expect(sym!.definitionSpan?.file).toBe('lib.si')
    })

    test('definitionSpan.line and col point to the name in lib.si', () => {
        const ws = twoDocWs()
        const sym = ws.findDefinition('main.si', 1, 11)
        expect(sym!.definitionSpan?.line).toBe(1)
        expect(sym!.definitionSpan?.col).toBe(5)
    })

    test('returns undefined for a position that covers no identifier', () => {
        const ws = twoDocWs()
        // col 7 is ' ' (space before ':=') — no symbol
        expect(ws.findDefinition('main.si', 1, 7)).toBeUndefined()
    })

    test('same-document resolution still works', () => {
        const ws = twoDocWs()
        // Ask for 'add' from lib.si itself (the definition site)
        const sym = ws.findDefinition('lib.si', 1, 5)
        expect(sym).toBeDefined()
        expect(sym!.name).toBe('add')
        expect(sym!.definitionSpan?.file).toBe('lib.si')
    })
})

// ---------------------------------------------------------------------------
// Cross-document findReferences
// ---------------------------------------------------------------------------

describe('Workspace.findReferences() — cross-document', () => {
    test('finds a reference in another document', () => {
        const ws = twoDocWs()
        // Stand on 'add' definition in lib.si
        const refs = ws.findReferences('lib.si', 1, 5)
        expect(refs.length).toBeGreaterThan(0)
        const mainRef = refs.find(s => s.file === 'main.si')
        expect(mainRef).toBeDefined()
    })

    test('reference span points to the call site in main.si', () => {
        const ws = twoDocWs()
        const refs = ws.findReferences('lib.si', 1, 5)
        const mainRef = refs.find(s => s.file === 'main.si')!
        expect(mainRef.line).toBe(1)
        expect(mainRef.col).toBe(11)  // 'add' starts at col 11 in MAIN
    })

    test('aggregates references from multiple documents', () => {
        const ws = new Workspace()
        ws.openDocument('lib.si',   LIB)
        ws.openDocument('main1.si', 'a := add(1, 2);')
        ws.openDocument('main2.si', 'b := add(3, 4);')

        const refs = ws.findReferences('lib.si', 1, 5)
        const files = new Set(refs.map(s => s.file))
        expect(files.has('main1.si')).toBe(true)
        expect(files.has('main2.si')).toBe(true)
    })

    test('deduplicates — same span not returned twice', () => {
        const ws = twoDocWs()
        const refs = ws.findReferences('lib.si', 1, 5)
        const keys = refs.map(s => `${s.file}:${s.line}:${s.col}`)
        const unique = new Set(keys)
        expect(keys.length).toBe(unique.size)
    })

    test('returns empty array when no references exist', () => {
        const ws = new Workspace()
        ws.openDocument('lib.si', '@fn unused := { 0 };')
        const refs = ws.findReferences('lib.si', 1, 5)
        expect(refs).toHaveLength(0)
    })

    test('findReferences from a call site also finds other call sites', () => {
        const ws = new Workspace()
        ws.openDocument('lib.si',   LIB)
        ws.openDocument('main1.si', 'a := add(1, 2);')
        ws.openDocument('main2.si', 'b := add(3, 4);')

        // Start from main1.si's call site ('add' at col 6 in 'a := add(')
        const refs = ws.findReferences('main1.si', 1, 6)
        const files = new Set(refs.map(s => s.file))
        expect(files.has('main2.si')).toBe(true)
    })
})

// ---------------------------------------------------------------------------
// referenceSpansForName — SemanticModel addition
// ---------------------------------------------------------------------------

describe('SemanticModel.referenceSpansForName()', () => {
    test('finds spans by name without needing a Symbol object', () => {
        const ws = twoDocWs()
        const doc = ws.getDocument('main.si')!
        // 'add' is referenced in main.si — the typechecker records the span
        // even when the symbol is not locally defined.
        const byName = doc.model.referenceSpansForName('add')
        expect(byName.length).toBeGreaterThan(0)
        expect(byName[0].file).toBe('main.si')
    })

    test('matches referenceSpans(sym) when sym is locally defined', () => {
        const ws = new Workspace()
        ws.openDocument('lib.si', '@fn add x, y := { x + y };\nr := add(1, 2);')
        const doc = ws.getDocument('lib.si')!
        const sym = doc.model.symbolNamed('add')!
        expect(doc.model.referenceSpansForName('add')).toEqual(doc.model.referenceSpans(sym))
    })

    test('returns empty for an unknown name', () => {
        const ws = twoDocWs()
        const doc = ws.getDocument('lib.si')!
        expect(doc.model.referenceSpansForName('nonexistent')).toHaveLength(0)
    })
})
