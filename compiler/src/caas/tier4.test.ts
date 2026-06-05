// SPDX-License-Identifier: MIT
/**
 * CaaS tracker Tier 4 tests — 4a isImplicitlyDeclared, 4d WorkspaceEdit,
 * 4e cancellable queries.
 */
import { describe, test, expect } from 'bun:test'
import { Workspace, WorkspaceEdit } from './workspace'

// ---------------------------------------------------------------------------
// 4a — Symbol.isImplicitlyDeclared
// ---------------------------------------------------------------------------

describe('Symbol.isImplicitlyDeclared (4a)', () => {
    test('user definitions are not implicit; @type variant constructors are', () => {
        const ws = new Workspace()
        const doc = ws.openDocument('shapes.si',
            '@type Shape := $Circle r Int | $Rectangle w Int, h Int;\n@fn area s := { 1 };')

        // The user-written function is an explicit declaration.
        expect(doc.model.symbolNamed('area')?.isImplicitlyDeclared).toBe(false)

        // The synthesized variant constructors are implicit declarations.
        const circle = doc.model.symbolNamed('Circle')
        expect(circle).toBeDefined()
        expect(circle!.isImplicitlyDeclared).toBe(true)
        expect(circle!.kind).toBe('function')
        expect(doc.model.symbolNamed('Rectangle')?.isImplicitlyDeclared).toBe(true)
    })
})

// ---------------------------------------------------------------------------
// 4d — WorkspaceEdit
// ---------------------------------------------------------------------------

describe('WorkspaceEdit (4d)', () => {
    function renamingWorkspace(): { ws: Workspace; edit: WorkspaceEdit } {
        const ws = new Workspace()
        ws.openDocument('lib.si', '\\\\ add (Int, Int)\n@fn add x, y := { x + y };')
        ws.openDocument('main.si', '@global r := &add 1, 2;')
        // rename `add` (its definition is on line 2, col 5 of lib.si)
        const edit = ws.rename('lib.si', 2, 5, 'plus')
        return { ws, edit }
    }

    test('rename returns a WorkspaceEdit with edits across files', () => {
        const { edit } = renamingWorkspace()
        expect(edit).toBeInstanceOf(WorkspaceEdit)
        expect(edit).toBeInstanceOf(Map)               // backward-compatible
        expect(edit.changeCount).toBeGreaterThan(0)
        expect(edit.uris).toContain('lib.si')
    })

    test('applyTo applies the rename to the workspace', () => {
        const { ws, edit } = renamingWorkspace()
        const changed = edit.applyTo(ws)
        expect(changed.length).toBeGreaterThan(0)
        expect(ws.getDocument('lib.si')!.source).toContain('plus')
        expect(ws.getDocument('lib.si')!.source).not.toContain('@fn add')
    })

    test('an empty WorkspaceEdit applies to nothing', () => {
        const ws = new Workspace()
        ws.openDocument('a.si', '@global x := 1;')
        expect(new WorkspaceEdit().applyTo(ws)).toEqual([])
    })
})

// ---------------------------------------------------------------------------
// 4e — cancellable queries
// ---------------------------------------------------------------------------

describe('cancellable queries (4e)', () => {
    test('an already-aborted signal makes the query throw', () => {
        const ws = new Workspace()
        ws.openDocument('a.si', '\\\\ f (Int)\n@fn f x := { x };\n@global r := &f 1;')
        const ctrl = new AbortController()
        ctrl.abort()

        expect(() => ws.getCompletions('a.si', 1, 1, undefined, { cancel: ctrl.signal })).toThrow()
        expect(() => ws.findReferences('a.si', 3, 11, { cancel: ctrl.signal })).toThrow()
    })

    test('a live signal does not interfere', () => {
        const ws = new Workspace()
        ws.openDocument('a.si', '@global x := 1;')
        const ctrl = new AbortController()
        expect(() => ws.getCompletions('a.si', 1, 1, undefined, { cancel: ctrl.signal })).not.toThrow()
        expect(() => ws.findReferences('a.si', 1, 1, { cancel: ctrl.signal })).not.toThrow()
    })
})
