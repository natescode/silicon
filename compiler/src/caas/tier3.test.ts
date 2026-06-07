// SPDX-License-Identifier: MIT
/**
 * CaaS tracker Tier 3 tests.
 *
 * 3a — Project layer: named, dependency-scoped groups of documents.
 *
 * The scoping signal mirrors the 2g cross-document tests: an unresolved
 * cross-document call degrades the inferred type to `Unknown` rather than
 * emitting an E0004 diagnostic, so the tests assert on
 * `symbolNamed(name)?.type?.kind` being `Unknown` vs. resolved.
 */
import { describe, test, expect } from 'bun:test'
import { Workspace } from './workspace'

// Signature line gives `add` a concrete Function type so cross-document
// resolution can produce a concrete return type (HM-lite does not infer a
// usable type for untyped, un-annotated parameters — see the 2g tests).
const ADD_LIB  = '\\\\ add (Int, Int)\n@fn add x, y := { x + y };'
const USES_ADD = 'r := add(1, 2);'

// ---------------------------------------------------------------------------
// Project creation & membership
// ---------------------------------------------------------------------------

describe('Project — creation and membership (3a)', () => {
    test('addProject returns a project with the given name and default target', () => {
        const ws = new Workspace()
        const p = ws.addProject('core')
        expect(p.name).toBe('core')
        expect(p.target).toBe('host')
        expect(ws.getProject('core')).toBe(p)
        expect(ws.projects.size).toBe(1)
    })

    test('addProject honours an explicit target', () => {
        const ws = new Workspace()
        const p = ws.addProject('gc', { target: 'wasm-gc' })
        expect(p.target).toBe('wasm-gc')
    })

    test('duplicate project name throws', () => {
        const ws = new Workspace()
        ws.addProject('core')
        expect(() => ws.addProject('core')).toThrow(/already exists/)
    })

    test('addDocument associates the document with the project', () => {
        const ws = new Workspace()
        const core = ws.addProject('core')
        const doc = core.addDocument('core/math.si', ADD_LIB)

        expect(doc.projectName).toBe('core')
        expect(ws.projectOf('core/math.si')).toBe(core)
        expect(core.documentUris).toContain('core/math.si')
        expect(core.documents.map(d => d.uri)).toEqual(['core/math.si'])
    })

    test('a document opened through the flat API is unassigned', () => {
        const ws = new Workspace()
        ws.addProject('core')
        const doc = ws.openDocument('loose.si', ADD_LIB)
        expect(doc.projectName).toBeUndefined()
        expect(ws.projectOf('loose.si')).toBeUndefined()
    })

    test('addDocument rejects a URI already open in the workspace', () => {
        const ws = new Workspace()
        const core = ws.addProject('core')
        core.addDocument('a.si', ADD_LIB)
        expect(() => core.addDocument('a.si', ADD_LIB)).toThrow(/already open/)
    })
})

// ---------------------------------------------------------------------------
// Cross-document scoping
// ---------------------------------------------------------------------------

describe('Project — cross-document scoping (3a)', () => {
    test('a dependent project sees the dependency project\'s symbols', () => {
        const ws = new Workspace()
        const core = ws.addProject('core')
        const app  = ws.addProject('app')
        app.addDependency(core)

        core.addDocument('core/math.si', ADD_LIB)
        app.addDocument('app/main.si', USES_ADD)

        const main = ws.getDocument('app/main.si')!
        // `add` resolves through the dependency → `r` is concretely typed.
        expect(main.model.symbolNamed('r')?.type?.kind).not.toBe('Unknown')
    })

    test('without a dependency edge the symbol is not visible', () => {
        const ws = new Workspace()
        const core = ws.addProject('core')
        const app  = ws.addProject('app')   // no dependency on core

        core.addDocument('core/math.si', ADD_LIB)
        app.addDocument('app/main.si', USES_ADD)

        const main = ws.getDocument('app/main.si')!
        // `add` is invisible across the project boundary → degrades to Unknown.
        expect(main.model.symbolNamed('r')?.type?.kind).toBe('Unknown')
    })

    test('adding a dependency edge makes symbols visible on the next edit', () => {
        const ws = new Workspace()
        const core = ws.addProject('core')
        const app  = ws.addProject('app')

        core.addDocument('core/math.si', ADD_LIB)
        app.addDocument('app/main.si', USES_ADD)
        expect(ws.getDocument('app/main.si')!.model.symbolNamed('r')?.type?.kind).toBe('Unknown')

        // Wire the dependency, then re-check by editing the consumer.
        app.addDependency(core)
        ws.editDocument('app/main.si', USES_ADD)
        expect(ws.getDocument('app/main.si')!.model.symbolNamed('r')?.type?.kind).not.toBe('Unknown')
    })

    test('visibility follows dependency direction (asymmetric)', () => {
        const ws = new Workspace()
        const core = ws.addProject('core')
        const app  = ws.addProject('app')
        app.addDependency(core)   // app → core, not core → app

        // `add` lives in app; core should NOT see it.
        app.addDocument('app/math.si', ADD_LIB)
        core.addDocument('core/main.si', USES_ADD)

        const main = ws.getDocument('core/main.si')!
        expect(main.model.symbolNamed('r')?.type?.kind).toBe('Unknown')
    })

    test('transitive dependencies are visible', () => {
        const ws = new Workspace()
        const a = ws.addProject('a')
        const b = ws.addProject('b')
        const c = ws.addProject('c')
        b.addDependency(a)
        c.addDependency(b)   // c → b → a

        a.addDocument('a/math.si', ADD_LIB)
        c.addDocument('c/main.si', USES_ADD)

        const main = ws.getDocument('c/main.si')!
        expect(main.model.symbolNamed('r')?.type?.kind).not.toBe('Unknown')
    })

    test('a dependency cycle does not hang and keeps symbols visible', () => {
        const ws = new Workspace()
        const a = ws.addProject('a')
        const b = ws.addProject('b')
        a.addDependency(b)
        b.addDependency(a)   // cycle

        a.addDocument('a/math.si', ADD_LIB)
        b.addDocument('b/main.si', USES_ADD)

        const main = ws.getDocument('b/main.si')!
        expect(main.model.symbolNamed('r')?.type?.kind).not.toBe('Unknown')
    })
})

// ---------------------------------------------------------------------------
// Interaction with unassigned documents
// ---------------------------------------------------------------------------

describe('Project — unassigned documents (3a)', () => {
    test('with no projects, the workspace stays flat (backward compatible)', () => {
        const ws = new Workspace()
        ws.openDocument('lib.si', ADD_LIB)
        ws.openDocument('main.si', USES_ADD)
        // No projects → every document sees every other, exactly as before.
        expect(ws.getDocument('main.si')!.model.symbolNamed('r')?.type?.kind).not.toBe('Unknown')
    })

    test('once a project exists, unassigned docs do not see projected symbols', () => {
        const ws = new Workspace()
        const core = ws.addProject('core')
        core.addDocument('core/math.si', ADD_LIB)

        // Loose document, never added to a project.
        ws.openDocument('loose.si', USES_ADD)
        expect(ws.getDocument('loose.si')!.model.symbolNamed('r')?.type?.kind).toBe('Unknown')
    })

    test('unassigned documents still see each other once a project exists', () => {
        const ws = new Workspace()
        ws.addProject('core')   // exists but holds no relevant symbols
        ws.openDocument('lib.si', ADD_LIB)
        ws.openDocument('main.si', USES_ADD)
        expect(ws.getDocument('main.si')!.model.symbolNamed('r')?.type?.kind).not.toBe('Unknown')
    })
})

describe('Project — completion is scoped to project visibility (3a)', () => {
    test('a project-scoped symbol completes only in dependent projects', () => {
        const ws = new Workspace()
        const core  = ws.addProject('core')
        const app   = ws.addProject('app')
        const other = ws.addProject('other')
        app.addDependency(core)

        core.addDocument('core/math.si', ADD_LIB)        // defines `add`
        app.addDocument('app/main.si', 'x := 1;')
        other.addDocument('other/c.si', 'y := 1;')

        // app depends on core → `add` is offered.
        expect(ws.getCompletions('app/main.si', 1, 1).map(c => c.label)).toContain('add')
        // other is unrelated → `add` is NOT offered.
        expect(ws.getCompletions('other/c.si', 1, 1).map(c => c.label)).not.toContain('add')
    })
})

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('Project — lifecycle (3a)', () => {
    test('closing a document removes it from its project', () => {
        const ws = new Workspace()
        const core = ws.addProject('core')
        core.addDocument('core/math.si', ADD_LIB)
        expect(core.documentUris).toContain('core/math.si')

        ws.closeDocument('core/math.si')
        expect(core.documentUris).not.toContain('core/math.si')
        expect(ws.projectOf('core/math.si')).toBeUndefined()
    })

    test('closing a dependency document degrades the dependent type', () => {
        const ws = new Workspace()
        const core = ws.addProject('core')
        const app  = ws.addProject('app')
        app.addDependency(core)
        core.addDocument('core/math.si', ADD_LIB)
        app.addDocument('app/main.si', USES_ADD)
        expect(ws.getDocument('app/main.si')!.model.symbolNamed('r')?.type?.kind).not.toBe('Unknown')

        ws.closeDocument('core/math.si')
        ws.editDocument('app/main.si', USES_ADD)
        expect(ws.getDocument('app/main.si')!.model.symbolNamed('r')?.type?.kind).toBe('Unknown')
    })

    test('a wasm-gc project compiles an ordinary program without portability errors', () => {
        const ws = new Workspace()
        const gc = ws.addProject('gc', { target: 'wasm-gc' })
        const doc = gc.addDocument('gc/main.si', ADD_LIB)
        // No introspection / physical-byte primitives → no E0012 / E0013.
        const portability = doc.diagnostics.filter(d => d.code === 'E0012' || d.code === 'E0013')
        expect(portability).toHaveLength(0)
    })
})
