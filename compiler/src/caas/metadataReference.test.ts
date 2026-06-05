// SPDX-License-Identifier: MIT
/**
 * CaaS tracker 3c — MetadataReference tests.
 *
 * A metadata reference exposes a precompiled library's symbols (no source) for
 * cross-document type checking, hover, and completion.
 */
import { describe, test, expect } from 'bun:test'
import { Workspace } from './workspace'
import { MetadataReference, serializeManifest, parseManifest, type SymbolManifest } from './metadataReference'
import type { SiliconType } from '../types/types'

const INT: SiliconType = { kind: 'Int' }
const ADD_FN: SiliconType = { kind: 'Function', params: [INT, INT], result: INT }

const MATH: SymbolManifest = {
    name: 'mathlib',
    symbols: [
        { name: 'add', kind: 'function', type: ADD_FN, doc: 'sum of two ints' },
        { name: 'PI',  kind: 'variable', type: INT },
    ],
}

// `add` Namespace sits at col 15 in `@global r := &add 1, 2;`
const USES_ADD = '@global r := &add 1, 2;'

// ---------------------------------------------------------------------------
// MetadataReference value type
// ---------------------------------------------------------------------------

describe('MetadataReference', () => {
    test('exposes symbols by name', () => {
        const ref = new MetadataReference(MATH)
        expect(ref.name).toBe('mathlib')
        expect(ref.symbolNamed('add')?.type).toEqual(ADD_FN)
        expect(ref.symbolNamed('missing')).toBeUndefined()
        expect(ref.uri).toBe('metadata:mathlib')
    })

    test('synthesizes CaaS symbols with a display string and no span', () => {
        const syms = new MetadataReference(MATH).caasSymbols()
        const add = syms.find(s => s.name === 'add')!
        expect(add.kind).toBe('function')
        expect(add.definitionSpan).toBeUndefined()
        expect(add.displayString.length).toBeGreaterThan(0)
    })

    test('manifest round-trips through JSON', () => {
        expect(parseManifest(serializeManifest(MATH))).toEqual(MATH)
    })
})

// ---------------------------------------------------------------------------
// Workspace-global references
// ---------------------------------------------------------------------------

describe('Workspace.addReference (global)', () => {
    test('a document type-checks against a referenced library symbol', () => {
        const ws = new Workspace()
        ws.addReference(MATH)
        const doc = ws.openDocument('main.si', USES_ADD)
        // `add` resolves through the reference → no unbound error, r is typed.
        expect(doc.diagnostics.filter(d => d.code === 'E0004')).toHaveLength(0)
        expect(doc.model.symbolNamed('r')?.type?.kind).not.toBe('Unknown')
    })

    test('without the reference, the call is unresolved', () => {
        const ws = new Workspace()
        const doc = ws.openDocument('main.si', USES_ADD)
        expect(doc.model.symbolNamed('r')?.type?.kind).toBe('Unknown')
    })

    test('hover resolves a reference symbol', () => {
        const ws = new Workspace()
        ws.addReference(MATH)
        ws.openDocument('main.si', USES_ADD)
        const hover = ws.hoverInfo('main.si', 1, 15)
        expect(hover?.symbol.name).toBe('add')
        expect(hover?.typeDisplay.length).toBeGreaterThan(0)
    })

    test('completion includes reference symbols', () => {
        const ws = new Workspace()
        ws.addReference(MATH)
        ws.openDocument('main.si', USES_ADD)
        const labels = ws.getCompletions('main.si', 1, 1).map(c => c.label)
        expect(labels).toContain('add')
        expect(labels).toContain('PI')
    })

    test('findDefinition returns the reference symbol (no source span)', () => {
        const ws = new Workspace()
        ws.addReference(MATH)
        ws.openDocument('main.si', USES_ADD)
        const sym = ws.findDefinition('main.si', 1, 15)
        expect(sym?.name).toBe('add')
        expect(sym?.definitionSpan).toBeUndefined()
    })

    test('getReference / references expose what was added', () => {
        const ws = new Workspace()
        const ref = ws.addReference(MATH)
        expect(ws.getReference('mathlib')).toBe(ref)
        expect([...ws.references.keys()]).toEqual(['mathlib'])
    })

    test('a local definition shadows a library symbol of the same name', () => {
        const ws = new Workspace()
        ws.addReference(MATH)
        // local `add` returning a String would change r's type away from the lib's Int
        const doc = ws.openDocument('main.si', '\\\\ add (Int) -> String\n@fn add x := { \'s\' };\n@global r := &add 1;')
        // resolves to the LOCAL add (1 arg), not the library's 2-arg add → no arity error
        expect(doc.diagnostics.filter(d => d.code === 'E0009')).toHaveLength(0)
    })
})

// ---------------------------------------------------------------------------
// Project-scoped references
// ---------------------------------------------------------------------------

describe('Project.addReference (scoped)', () => {
    test('visible to the project and its dependents, not to unrelated projects', () => {
        const ws = new Workspace()
        const core = ws.addProject('core')
        const app  = ws.addProject('app')
        const other = ws.addProject('other')
        app.addDependency(core)

        core.addReference(MATH)

        core.addDocument('core/a.si', USES_ADD)
        app.addDocument('app/b.si', USES_ADD)      // depends on core → sees it
        other.addDocument('other/c.si', USES_ADD)  // unrelated → does not

        expect(ws.getDocument('core/a.si')!.model.symbolNamed('r')?.type?.kind).not.toBe('Unknown')
        expect(ws.getDocument('app/b.si')!.model.symbolNamed('r')?.type?.kind).not.toBe('Unknown')
        expect(ws.getDocument('other/c.si')!.model.symbolNamed('r')?.type?.kind).toBe('Unknown')
    })

    test('project references are listed on the project', () => {
        const ws = new Workspace()
        const p = ws.addProject('p')
        const ref = p.addReference(MATH)
        expect(p.references).toEqual([ref])
    })
})
