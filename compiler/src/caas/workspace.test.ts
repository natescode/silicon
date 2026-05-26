import { describe, test, expect } from 'bun:test'
import { Workspace } from './workspace'
import { buildRegistry, parse } from './index'
import type { DocumentChangeEvent } from './workspace'

const SRC1 = '@fn answer:Int := { 42 };'
const SRC2 = '@fn answer:Int := { 99 };'
const BAD  = '@@@@invalid'

describe('Workspace — openDocument()', () => {
    test('opens a document and returns it', () => {
        const ws = new Workspace()
        const doc = ws.openDocument('a.si', SRC1)
        expect(doc.uri).toBe('a.si')
        expect(doc.source).toBe(SRC1)
        expect(doc.version).toBe(1)
    })

    test('tree, elabTree, model are all defined', () => {
        const ws = new Workspace()
        const doc = ws.openDocument('a.si', SRC1)
        expect(doc.tree).toBeDefined()
        expect(doc.elabTree).toBeDefined()
        expect(doc.model).toBeDefined()
        expect(typeof doc.model.typeOf).toBe('function')
    })

    test('diagnostics array is present (empty on valid input)', () => {
        const ws = new Workspace()
        const doc = ws.openDocument('a.si', SRC1)
        expect(Array.isArray(doc.diagnostics)).toBe(true)
        expect(doc.diagnostics).toHaveLength(0)
    })

    test('captures parse errors in diagnostics, does not throw', () => {
        const ws = new Workspace()
        const doc = ws.openDocument('bad.si', BAD)
        expect(doc.diagnostics.length).toBeGreaterThan(0)
        expect(doc.diagnostics[0].phase).toBe('parse')
    })

    test('document is retrievable via getDocument()', () => {
        const ws = new Workspace()
        ws.openDocument('a.si', SRC1)
        expect(ws.getDocument('a.si')).toBeDefined()
        expect(ws.getDocument('a.si')!.source).toBe(SRC1)
    })

    test('document appears in ws.documents', () => {
        const ws = new Workspace()
        ws.openDocument('a.si', SRC1)
        expect(ws.documents.size).toBe(1)
        expect(ws.documents.has('a.si')).toBe(true)
    })

    test('throws if document already open', () => {
        const ws = new Workspace()
        ws.openDocument('a.si', SRC1)
        expect(() => ws.openDocument('a.si', SRC2)).toThrow('already open')
    })

    test('multiple documents can be opened independently', () => {
        const ws = new Workspace()
        ws.openDocument('a.si', SRC1)
        ws.openDocument('b.si', SRC2)
        expect(ws.documents.size).toBe(2)
    })

    test('builds the registry on first open', () => {
        const ws = new Workspace()
        expect(ws.registry).toBeUndefined()
        ws.openDocument('a.si', SRC1)
        expect(ws.registry).toBeDefined()
    })

    test('reuses the registry across subsequent opens', () => {
        const ws = new Workspace()
        ws.openDocument('a.si', SRC1)
        const reg1 = ws.registry
        ws.openDocument('b.si', SRC2)
        expect(ws.registry).toBe(reg1)
    })
})

describe('Workspace — editDocument()', () => {
    test('updates the document source', () => {
        const ws = new Workspace()
        ws.openDocument('a.si', SRC1)
        const doc = ws.editDocument('a.si', SRC2)
        expect(doc.source).toBe(SRC2)
    })

    test('increments the version', () => {
        const ws = new Workspace()
        ws.openDocument('a.si', SRC1)
        const doc = ws.editDocument('a.si', SRC2)
        expect(doc.version).toBe(2)
        const doc2 = ws.editDocument('a.si', SRC1)
        expect(doc2.version).toBe(3)
    })

    test('throws if document not open', () => {
        const ws = new Workspace()
        expect(() => ws.editDocument('x.si', SRC1)).toThrow('not open')
    })

    test('getDocument returns the updated version', () => {
        const ws = new Workspace()
        ws.openDocument('a.si', SRC1)
        ws.editDocument('a.si', SRC2)
        expect(ws.getDocument('a.si')!.source).toBe(SRC2)
    })

    test('edit with invalid source captures diagnostics', () => {
        const ws = new Workspace()
        ws.openDocument('a.si', SRC1)
        const doc = ws.editDocument('a.si', BAD)
        expect(doc.diagnostics.length).toBeGreaterThan(0)
    })
})

describe('Workspace — closeDocument()', () => {
    test('removes the document', () => {
        const ws = new Workspace()
        ws.openDocument('a.si', SRC1)
        ws.closeDocument('a.si')
        expect(ws.getDocument('a.si')).toBeUndefined()
        expect(ws.documents.size).toBe(0)
    })

    test('no-ops if document was never open', () => {
        const ws = new Workspace()
        expect(() => ws.closeDocument('x.si')).not.toThrow()
    })
})

describe('Workspace — onDidChange()', () => {
    test('fires opened event on openDocument', () => {
        const ws = new Workspace()
        const events: DocumentChangeEvent[] = []
        ws.onDidChange(e => events.push(e))
        ws.openDocument('a.si', SRC1)
        expect(events).toHaveLength(1)
        expect(events[0].kind).toBe('opened')
        expect(events[0].uri).toBe('a.si')
        expect(events[0].document).toBeDefined()
    })

    test('fires changed event on editDocument', () => {
        const ws = new Workspace()
        const events: DocumentChangeEvent[] = []
        ws.openDocument('a.si', SRC1)
        ws.onDidChange(e => events.push(e))
        ws.editDocument('a.si', SRC2)
        expect(events).toHaveLength(1)
        expect(events[0].kind).toBe('changed')
        expect(events[0].document!.source).toBe(SRC2)
    })

    test('fires closed event on closeDocument', () => {
        const ws = new Workspace()
        const events: DocumentChangeEvent[] = []
        ws.openDocument('a.si', SRC1)
        ws.onDidChange(e => events.push(e))
        ws.closeDocument('a.si')
        expect(events).toHaveLength(1)
        expect(events[0].kind).toBe('closed')
        expect(events[0].document).toBeUndefined()
    })

    test('unsubscribe stops future events', () => {
        const ws = new Workspace()
        const events: DocumentChangeEvent[] = []
        const unsub = ws.onDidChange(e => events.push(e))
        ws.openDocument('a.si', SRC1)
        unsub()
        ws.editDocument('a.si', SRC2)
        expect(events).toHaveLength(1)  // only the open event
    })

    test('multiple listeners all fire', () => {
        const ws = new Workspace()
        let count = 0
        ws.onDidChange(() => count++)
        ws.onDidChange(() => count++)
        ws.openDocument('a.si', SRC1)
        expect(count).toBe(2)
    })

    test('event document matches getDocument at that moment', () => {
        const ws = new Workspace()
        let captured: DocumentChangeEvent | undefined
        ws.onDidChange(e => { captured = e })
        ws.openDocument('a.si', SRC1)
        expect(captured!.document).toBe(ws.getDocument('a.si'))
    })
})

describe('Workspace — constructor options', () => {
    test('accepts a pre-built registry', () => {
        const { tree } = parse(SRC1)
        const reg = buildRegistry(tree)

        const ws = new Workspace({ registry: reg })
        expect(ws.registry).toBe(reg)

        const doc = ws.openDocument('a.si', SRC1)
        expect(doc.diagnostics).toHaveLength(0)
        // Registry is not replaced when one was pre-supplied.
        expect(ws.registry).toBe(reg)
    })
})
