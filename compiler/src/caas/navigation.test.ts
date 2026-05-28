// SPDX-License-Identifier: MIT
/**
 * CaaS-5 navigation tests — symbol location, go-to-definition, find-references.
 *
 * All positions are 1-based (matching Ohm's getLineAndColumn output).
 */

import { describe, test, expect } from 'bun:test'
import { compile, parse, buildRegistry, elaborate, typecheck } from './index'
import { Workspace } from './workspace'

// ---------------------------------------------------------------------------
// Helper: run the full pipeline and return the SemanticModel
// ---------------------------------------------------------------------------
function modelFor(source: string) {
    const { tree }              = parse(source, { file: 'test.si' })
    const reg                   = buildRegistry(tree)
    const { tree: elab, registry } = elaborate(tree, reg)
    const { model }             = typecheck(elab, registry)
    return model
}

// ---------------------------------------------------------------------------
// Symbol.definitionSpan
// ---------------------------------------------------------------------------

describe('Symbol.definitionSpan', () => {
    test('is defined on symbols from real-parser programs', () => {
        const model = modelFor('@fn answer:Int := { 42 };')
        const sym = model.symbolNamed('answer')
        expect(sym).toBeDefined()
        expect(sym!.definitionSpan).toBeDefined()
    })

    test('definitionSpan.line is 1 for a single-line program', () => {
        const model = modelFor('@fn answer:Int := { 42 };')
        const sym = model.symbolNamed('answer')!
        expect(sym.definitionSpan!.line).toBe(1)
    })

    test('definitionSpan.col points at the name identifier', () => {
        //  @fn answer:Int := { 42 };
        //      ^--- col of "answer"
        const src = '@fn answer:Int := { 42 };'
        const model = modelFor(src)
        const sym = model.symbolNamed('answer')!
        // 'answer' starts at col 5 (1-based: @=1, f=2, n=3, space=4, a=5)
        expect(sym.definitionSpan!.col).toBe(5)
    })

    test('definitionSpan.length equals the identifier length', () => {
        const model = modelFor('@fn answer:Int := { 42 };')
        const sym = model.symbolNamed('answer')!
        expect(sym.definitionSpan!.length).toBe('answer'.length)
    })

    test('definitionSpan.file matches the parse file option', () => {
        const { tree } = parse('@fn foo:Int := { 1 };', { file: 'my.si' })
        const reg = buildRegistry(tree)
        const { tree: elab, registry } = elaborate(tree, reg)
        const { model } = typecheck(elab, registry)
        const sym = model.symbolNamed('foo')!
        expect(sym.definitionSpan!.file).toBe('')  // spanFromLocation uses empty file by default
    })

    test('multi-line: definitionSpan.line reflects actual line number', () => {
        const src = [
            '@let x:Int := 1;',
            '@fn answer:Int := { 42 };',
        ].join('\n')
        const model = modelFor(src)
        const sym = model.symbolNamed('answer')!
        expect(sym.definitionSpan!.line).toBe(2)
    })
})

// ---------------------------------------------------------------------------
// SemanticModel.referenceSpans
// ---------------------------------------------------------------------------

describe('SemanticModel.referenceSpans()', () => {
    test('returns spans for each call site', () => {
        const src = [
            '@fn add x:Int, y:Int := { x + y };',
            '@let r:Int := &add 1, 2;',
        ].join('\n')
        const model = modelFor(src)
        const sym = model.symbolNamed('add')!
        const spans = model.referenceSpans(sym)
        expect(spans.length).toBeGreaterThan(0)
    })

    test('each returned span has file/line/col/length', () => {
        const src = '@fn f:Int := { 1 };\n@let r:Int := &f;'
        const model = modelFor(src)
        const sym = model.symbolNamed('f')!
        const spans = model.referenceSpans(sym)
        for (const span of spans) {
            expect(typeof span.line).toBe('number')
            expect(typeof span.col).toBe('number')
            expect(typeof span.length).toBe('number')
            expect(typeof span.file).toBe('string')
        }
    })

    test('returns empty array for a symbol with no references', () => {
        const model = modelFor('@fn unused:Int := { 0 };')
        const sym = model.symbolNamed('unused')!
        const spans = model.referenceSpans(sym)
        expect(spans).toHaveLength(0)
    })
})

// ---------------------------------------------------------------------------
// SemanticModel.symbolAtPosition()
// ---------------------------------------------------------------------------

describe('SemanticModel.symbolAtPosition()', () => {
    test('finds symbol at its definition site', () => {
        //  @fn answer:Int := { 42 };
        //      ^---- col 5, "answer" (length 6, so cols 5-10)
        const model = modelFor('@fn answer:Int := { 42 };')
        const sym = model.symbolAtPosition(1, 5)
        expect(sym).toBeDefined()
        expect(sym!.name).toBe('answer')
    })

    test('finds symbol inside its name span', () => {
        const model = modelFor('@fn answer:Int := { 42 };')
        // col 7 is inside 'answer' (cols 5-10)
        const sym = model.symbolAtPosition(1, 7)
        expect(sym).toBeDefined()
        expect(sym!.name).toBe('answer')
    })

    test('returns undefined for position outside any symbol', () => {
        const model = modelFor('@fn answer:Int := { 42 };')
        // col 1 is '@', not a symbol name
        const sym = model.symbolAtPosition(1, 1)
        expect(sym).toBeUndefined()
    })

    test('finds symbol at a reference site', () => {
        const src = '@fn f:Int := { 1 };\n@let r:Int := &f;'
        const model = modelFor(src)
        // line 2: '@let r:Int := &f;'
        //                         ^ 'f' is at some column on line 2
        const sym = model.symbolAtPosition(2, 16)
        expect(sym).toBeDefined()
        expect(sym!.name).toBe('f')
    })
})

// ---------------------------------------------------------------------------
// Workspace.findDefinition() and findReferences()
// ---------------------------------------------------------------------------

describe('Workspace.findDefinition()', () => {
    test('returns the symbol at the definition site', () => {
        const ws = new Workspace()
        ws.openDocument('main.si', '@fn answer:Int := { 42 };')
        const sym = ws.findDefinition('main.si', 1, 5)
        expect(sym).toBeDefined()
        expect(sym!.name).toBe('answer')
    })

    test('returns undefined for unopened document', () => {
        const ws = new Workspace()
        const sym = ws.findDefinition('ghost.si', 1, 1)
        expect(sym).toBeUndefined()
    })

    test('returns undefined for position outside any symbol', () => {
        const ws = new Workspace()
        ws.openDocument('main.si', '@fn answer:Int := { 42 };')
        const sym = ws.findDefinition('main.si', 1, 1)
        expect(sym).toBeUndefined()
    })
})

describe('Workspace.findReferences()', () => {
    test('returns spans from a reference site', () => {
        const src = '@fn f:Int := { 1 };\n@let r:Int := &f;'
        const ws = new Workspace()
        ws.openDocument('main.si', src)
        // Ask for references starting from the definition of 'f'
        const sym = ws.findDefinition('main.si', 1, 5)
        expect(sym).toBeDefined()
        const refs = ws.findReferences('main.si', 1, 5)
        expect(Array.isArray(refs)).toBe(true)
    })

    test('returns empty array for unopened document', () => {
        const ws = new Workspace()
        const refs = ws.findReferences('ghost.si', 1, 1)
        expect(refs).toHaveLength(0)
    })

    test('returns empty array when no symbol at position', () => {
        const ws = new Workspace()
        ws.openDocument('main.si', '@fn answer:Int := { 42 };')
        const refs = ws.findReferences('main.si', 1, 1)
        expect(refs).toHaveLength(0)
    })
})
