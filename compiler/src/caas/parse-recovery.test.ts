// SPDX-License-Identifier: MIT
/**
 * Parser error recovery (CaaS): a syntax error in one top-level element must not
 * discard the rest of the file.  The recovering `parse()` keeps the well-formed
 * elements, emits a `ParseError` node for the broken span, and still produces
 * per-element extents — so the incremental pipeline + LSP model stay alive while
 * the user is mid-edit.
 */
import { describe, test, expect } from 'bun:test'
import { parse } from './index'

const elemTypes = (r: ReturnType<typeof parse>): string[] =>
    (r.tree.program as any).elements.map((e: any) => e.type)
const names = (r: ReturnType<typeof parse>): string[] =>
    (r.tree.program as any).elements.filter((e: any) => e.name?.name).map((e: any) => e.name.name)

describe('parser error recovery', () => {
    test('a trailing incomplete line keeps the earlier definitions', () => {
        const r = parse('@fn a := { 1 };\n@let b := 2;\n@let t := &ad', { file: 'm.si' })
        expect(names(r)).toEqual(['a', 'b'])
        expect(elemTypes(r)).toContain('ParseError')
        expect(r.diagnostics.length).toBeGreaterThanOrEqual(1)
        expect(r.diagnostics[0].code).toBe('E0000')
        // extents are produced even on a recovered parse (drives incremental reuse)
        expect(r.tree._extents).toBeDefined()
        expect(r.tree._extents!.length).toBe(3)
    })

    test('a broken element between two good ones keeps both', () => {
        const r = parse('@fn a := { 1 };\n@@@ junk\n@fn b := { 2 };', { file: 'm.si' })
        expect(names(r)).toContain('a')
        expect(names(r)).toContain('b')
        expect(elemTypes(r)).toContain('ParseError')
    })

    test('a clean program has no ParseError nodes and no diagnostics', () => {
        const r = parse('@fn a := { 1 };\n@fn b := { 2 };', { file: 'm.si' })
        expect(elemTypes(r)).toEqual(['Definition', 'Definition'])
        expect(r.diagnostics).toEqual([])
    })

    test('the diagnostic span points inside the broken element (not 1:1)', () => {
        const r = parse('@let a := 1;\n@let b := ;', { file: 'm.si' })
        const d = r.diagnostics.find(x => x.code === 'E0000')!
        expect(d.span.line).toBe(2)   // the error is on line 2, not the default 1
    })

    test('adjacent errors make progress (no infinite loop)', () => {
        // Several broken elements in a row must each terminate.
        const r = parse('@@@ \n@@@ \n@fn ok := { 1 };', { file: 'm.si' })
        expect(names(r)).toContain('ok')
        expect(r.diagnostics.length).toBeGreaterThanOrEqual(1)
    })

    test('the recovered tree elaborates + typechecks without crashing', async () => {
        // Downstream tolerance: a ParseError element is benign (skipped), the good
        // ones still type-check and appear in the model.
        const { Workspace } = await import('./workspace')
        const ws = new Workspace()
        const doc = ws.openDocument('m.si', '@fn a := { 1 };\n@let t := &ad')
        expect(doc.diagnostics.some(d => d.code === 'E0000')).toBe(true)
        expect([...doc.model.allSymbols].map(s => s.name)).toContain('a')
    })
})
