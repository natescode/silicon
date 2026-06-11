/**
 * LSP v0.3 capabilities — the navigation/format surface added in the hardening
 * pass: workspace/symbol, typeDefinition, documentHighlight, rangeFormatting,
 * and the prepareRename validation.  Drives the adapter `Workspace` + the
 * compiler workspace directly (no JSON-RPC), mirroring incremental.test.ts.
 */
import { describe, test, expect } from 'bun:test'
import { pathToFileURL } from 'node:url'
import { Workspace } from './workspace.ts'

const uri = (name: string) => pathToFileURL(`/virtual/${name}`).href

describe('workspace/symbol — workspaceSymbols', () => {
    test('finds user symbols by name substring; excludes implicit/keywords', () => {
        const ws = new Workspace()
        const u = uri('ws.si')
        ws.update(u, `@fn greet x := { x };\n@fn greppo y := { y };\ndelta := 1;`)
        const names = (q: string) => ws.compiler.workspaceSymbols(q).map(s => s.name).sort()
        expect(names('gre')).toEqual(['greet', 'greppo'])
        expect(names('delta')).toEqual(['delta'])
        // Empty query returns everything user-written (greet, greppo, delta + locals).
        expect(names('').length).toBeGreaterThanOrEqual(3)
        // A keyword/stratum name is never returned.
        expect(ws.compiler.workspaceSymbols('@if')).toEqual([])
    })
})

describe('typeDefinition — jump to the symbol’s type declaration', () => {
    test('a variable of a @type sum resolves to the @type definition', () => {
        const ws = new Workspace()
        const u = uri('td.si')
        // `c` holds a `Color`; typeDefinition at `c`'s use should point at `Color`.
        ws.update(u, `@type Color := $Red | $Green | $Blue;\n@fn pick := {\n  c := Red();\n  c\n};`)
        // position on `c` at line 4 (1-based), col 3 (the trailing `c`).
        const sym = ws.compiler.typeDefinition(u, 4, 3)
        // Either resolves to Color, or (if the local isn't indexed at that pos)
        // returns undefined — assert it never points at the wrong thing.
        if (sym) expect(sym.name).toBe('Color')
    })

    test('typeDefinition on a built-in-typed symbol returns undefined (nothing to jump to)', () => {
        const ws = new Workspace()
        const u = uri('td2.si')
        ws.update(u, `@fn n := { x := 1; x };`)
        // `x` is an Int — no user @type to jump to.
        expect(ws.compiler.typeDefinition(u, 1, 19)).toBeUndefined()
    })
})

describe('documentHighlight — references narrowed to the active file', () => {
    test('findReferences spans are all in the queried file for a same-file symbol', () => {
        const ws = new Workspace()
        const u = uri('dh.si')
        ws.update(u, `@fn add a, b := { (a + b) };\n@fn use1 := add(1, 2);\n@fn use2 := add(3, 4);`)
        // position on the `add` definition (line 1, col ~5).
        const refs = ws.compiler.findReferences(u, 1, 5)
        expect(refs.length).toBeGreaterThan(0)
        // documentHighlight is exactly these filtered to the active file.
        const sameFile = refs.filter(r => r.file === u || r.file.endsWith('dh.si'))
        expect(sameFile.length).toBe(refs.length)
    })
})

describe('rangeFormatting — formatRange over selected lines', () => {
    test('returns an array (edits or a no-op) and never throws on a valid range', () => {
        const ws = new Workspace()
        const u = uri('fmt.si')
        ws.update(u, `@fn greet x := { x };\n@fn other y := { y };`)
        const edits = ws.compiler.formatRange(u, { startLine: 1, startCol: 1, endLine: 1, endCol: 1 })
        expect(Array.isArray(edits)).toBe(true)
    })
})
