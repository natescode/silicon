// SPDX-License-Identifier: MIT
/**
 * Cross-file diagnostic invalidation (LSP tail).
 *
 * A document's diagnostics depend on other documents only through its
 * external-symbol surface, so `refreshDependents(changedUri)` re-checks
 * exactly the open documents whose visible surface changed — no @use graph
 * to maintain.  These tests pin the three behaviours the LSP relies on:
 * stale diagnostics APPEAR, stale diagnostics CLEAR, and body-only edits
 * refresh nothing.
 */
import { describe, test, expect } from 'bun:test'
import { Workspace } from './workspace'

describe('Workspace.refreshDependents — cross-file diagnostic invalidation', () => {
    test('renaming a referenced definition surfaces E0004 in the dependent doc', () => {
        const ws = new Workspace()
        ws.openDocument('lib.si', '@fn add x, y := { x + y };')
        const main = ws.openDocument('main.si', 'f := add;')
        expect(main.diagnostics).toHaveLength(0)

        // Rename add → plus: main.si's `add` reference is now unbound, but
        // main.si itself was not edited — only refreshDependents surfaces it.
        ws.editDocument('lib.si', '@fn plus x, y := { x + y };')
        const refreshed = ws.refreshDependents('lib.si')

        const refreshedMain = refreshed.find(d => d.uri === 'main.si')
        expect(refreshedMain).toBeDefined()
        expect(refreshedMain!.diagnostics.some(d => d.code === 'E0004')).toBe(true)
        // The workspace's stored state was updated too.
        expect(ws.getDocument('main.si')!.diagnostics.some(d => d.code === 'E0004')).toBe(true)
    })

    test('a dependency type change flows into the dependent doc (E0003)', () => {
        const ws = new Workspace()
        ws.openDocument('lib.si', 'v := 1;')
        const main = ws.openDocument('main.si', 'r := v + 1;')
        expect(main.diagnostics).toHaveLength(0)

        ws.editDocument('lib.si', 'v := 1.5;')   // v: Int → Float
        const refreshed = ws.refreshDependents('lib.si')

        const refreshedMain = refreshed.find(d => d.uri === 'main.si')
        expect(refreshedMain).toBeDefined()
        expect(refreshedMain!.diagnostics.some(d => d.code === 'E0003')).toBe(true)
    })

    test('restoring the definition clears the dependent doc diagnostics', () => {
        const ws = new Workspace()
        ws.openDocument('lib.si', '@fn plus x, y := { x + y };')
        ws.openDocument('main.si', 'f := add;')
        expect(ws.getDocument('main.si')!.diagnostics.length).toBeGreaterThan(0)

        ws.editDocument('lib.si', '@fn add x, y := { x + y };')
        const refreshed = ws.refreshDependents('lib.si')

        const refreshedMain = refreshed.find(d => d.uri === 'main.si')
        expect(refreshedMain).toBeDefined()
        expect(refreshedMain!.diagnostics).toHaveLength(0)
    })

    test('a body-only edit (same exported surface) refreshes nothing', () => {
        const ws = new Workspace()
        ws.openDocument('lib.si', '@fn add x, y := { x + y };')
        ws.openDocument('main.si', 'f := add;')

        ws.editDocument('lib.si', '@fn add x, y := { y + x };')
        expect(ws.refreshDependents('lib.si')).toHaveLength(0)
    })

    test('refreshDocument is a no-op when the visible surface is unchanged', () => {
        const ws = new Workspace()
        ws.openDocument('lib.si', '@fn add x, y := { x + y };')
        ws.openDocument('main.si', 'f := add;')
        expect(ws.refreshDocument('main.si')).toBeUndefined()
        expect(ws.refreshDocument('missing.si')).toBeUndefined()
    })

    test('opening a new document makes an earlier-opened dependent doc resolve', () => {
        // main.si opened FIRST — compiled without `add`, so it has an unbound
        // diagnostic.  Opening lib.si then refreshing clears it.
        const ws = new Workspace()
        ws.openDocument('main.si', 'f := add;')
        expect(ws.getDocument('main.si')!.diagnostics.length).toBeGreaterThan(0)

        ws.openDocument('lib.si', '@fn add x, y := { x + y };')
        const refreshed = ws.refreshDependents('lib.si')
        expect(refreshed.find(d => d.uri === 'main.si')!.diagnostics).toHaveLength(0)
    })

    test('refresh fires a changed event for republish-by-subscription consumers', () => {
        const ws = new Workspace()
        ws.openDocument('lib.si', '@fn add x, y := { x + y };')
        ws.openDocument('main.si', 'f := add;')

        const events: string[] = []
        ws.onDidChange(e => events.push(`${e.kind}:${e.uri}`))
        ws.editDocument('lib.si', '@fn plus x, y := { x + y };')
        ws.refreshDependents('lib.si')
        expect(events).toContain('changed:main.si')
    })

    test('project scoping: an unrelated project is never refreshed', () => {
        const ws = new Workspace()
        const app = ws.addProject('app')
        const other = ws.addProject('other')
        app.addDocument('app/lib.si', '@fn add x, y := { x + y };')
        app.addDocument('app/main.si', 'f := add;')
        other.addDocument('other/main.si', 'x := 1;')
        const otherBefore = ws.getDocument('other/main.si')!

        ws.editDocument('app/lib.si', '@fn plus x, y := { x + y };')
        const refreshed = ws.refreshDependents('app/lib.si')

        expect(refreshed.some(d => d.uri === 'app/main.si')).toBe(true)
        expect(refreshed.some(d => d.uri === 'other/main.si')).toBe(false)
        // Not even a version bump — the document object is untouched.
        expect(ws.getDocument('other/main.si')).toBe(otherBefore)
    })
})
