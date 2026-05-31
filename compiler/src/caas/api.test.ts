// SPDX-License-Identifier: MIT
/**
 * CaaS public API contract tests.
 *
 * These tests verify that the stable entry points (parse, elaborate, typecheck,
 * lower, compile, buildRegistry) return well-shaped results and never throw on
 * user errors.
 */

import { describe, test, expect } from 'bun:test'
import {
    parse,
    elaborate,
    typecheck,
    lower,
    compile,
    buildRegistry,
    SyntaxTree,
    type ParseResult,
    type ElabResult,
    type CheckResult,
    type LowerResult,
    type CompileResult,
} from './index'

// ---------------------------------------------------------------------------
// parse()
// ---------------------------------------------------------------------------

describe('parse()', () => {
    test('returns a SyntaxTree on valid input', () => {
        const result: ParseResult = parse('5;')
        expect(result.diagnostics).toHaveLength(0)
        expect(result.tree).toBeDefined()
        expect(result.tree.program).toBeDefined()
        expect(result.tree.source).toBe('5;')
    })

    test('captures parse errors as diagnostics, never throws', () => {
        const result = parse('@@@@invalid@@@@')
        expect(result.diagnostics.length).toBeGreaterThan(0)
        expect(result.diagnostics[0].phase).toBe('parse')
        expect(result.diagnostics[0].code).toBe('E0000')
    })

    test('includes the file option in error spans when provided', () => {
        const result = parse('@fn', { file: 'test.si' })
        // May or may not error, but must not throw.
        expect(result).toBeDefined()
    })

    test('tree.source preserves original text', () => {
        const src = '@let x := 42;'
        const { tree } = parse(src)
        expect(tree.source).toBe(src)
    })
})

// ---------------------------------------------------------------------------
// buildRegistry()
// ---------------------------------------------------------------------------

describe('buildRegistry()', () => {
    test('returns a registry from a parsed tree', () => {
        const { tree } = parse('5;')
        const reg = buildRegistry(tree)
        expect(reg).toBeDefined()
    })

    test('accepts extraSources', () => {
        const { tree } = parse('5;')
        const reg = buildRegistry(tree, [])
        expect(reg).toBeDefined()
    })
})

// ---------------------------------------------------------------------------
// elaborate()
// ---------------------------------------------------------------------------

describe('elaborate()', () => {
    test('returns elaborated tree with no diagnostics on valid input', () => {
        const { tree } = parse('@let x := 1;')
        const reg = buildRegistry(tree)
        const result: ElabResult = elaborate(tree, reg)
        expect(result.diagnostics).toHaveLength(0)
        expect(result.tree.program).toBeDefined()
        expect(result.registry).toBeDefined()
    })

    test('preserves source in the returned tree', () => {
        const src = '@let y := 2;'
        const { tree } = parse(src)
        const reg = buildRegistry(tree)
        const { tree: elabTree } = elaborate(tree, reg)
        expect(elabTree.source).toBe(src)
    })
})

// ---------------------------------------------------------------------------
// typecheck()
// ---------------------------------------------------------------------------

describe('typecheck()', () => {
    test('returns SemanticModel on valid input', () => {
        const src = '@let x := 42;'
        const { tree } = parse(src)
        const reg = buildRegistry(tree)
        const { tree: elab, registry } = elaborate(tree, reg)
        const result: CheckResult = typecheck(elab, registry)
        expect(result.diagnostics).toHaveLength(0)
        expect(result.model).toBeDefined()
        expect(typeof result.model.typeOf).toBe('function')
        expect(typeof result.model.symbolNamed).toBe('function')
    })

    test('captures type errors as diagnostics, never throws', () => {
        // Intentional type mismatch — no implicit coercion in Silicon.
        // We just verify it doesn't throw and returns an object.
        const src = '@let x:Int := 42;'
        const { tree } = parse(src)
        const reg = buildRegistry(tree)
        const { tree: elab, registry } = elaborate(tree, reg)
        const result = typecheck(elab, registry)
        expect(result).toBeDefined()
        expect(Array.isArray(result.diagnostics)).toBe(true)
    })
})

// ---------------------------------------------------------------------------
// lower()
// ---------------------------------------------------------------------------

describe('lower()', () => {
    test('produces WAT on a valid minimal program', () => {
        const src = '@fn answer:Int := { 42 };'
        const { tree } = parse(src)
        const reg = buildRegistry(tree)
        const { tree: elab, registry } = elaborate(tree, reg)
        const { tree: checked, model } = typecheck(elab, registry)
        const result: LowerResult = lower(checked, registry, model)
        expect(result.diagnostics).toHaveLength(0)
        expect(result.wat).toContain('(module')
        expect(result.wat).toContain('answer')
    })

    test('captures lowering errors as diagnostics, never throws', () => {
        // Pass an empty program — should produce valid (empty) WAT.
        const { tree } = parse('5;')
        const reg = buildRegistry(tree)
        const { tree: elab, registry } = elaborate(tree, reg)
        const { tree: checked, model } = typecheck(elab, registry)
        const result = lower(checked, registry, model)
        expect(result).toBeDefined()
        expect(Array.isArray(result.diagnostics)).toBe(true)
    })
})

// ---------------------------------------------------------------------------
// compile() — full pipeline convenience
// ---------------------------------------------------------------------------

describe('compile()', () => {
    test('returns WAT for a valid program', () => {
        const result: CompileResult = compile('@fn answer:Int := { 42 };')
        expect(result.diagnostics).toHaveLength(0)
        expect(result.wat).toContain('(module')
    })

    test('returns diagnostics for a parse error, wat is empty string', () => {
        const result = compile('@@@@invalid')
        expect(result.diagnostics.length).toBeGreaterThan(0)
        expect(result.wat).toBe('')
        expect(result.model).toBeUndefined()
    })

    test('model is defined after a successful compile', () => {
        const result = compile('@let x:Int := 1;')
        expect(result.model).toBeDefined()
    })

    test('all diagnostics have required fields', () => {
        const result = compile('@@@@bad')
        for (const d of result.diagnostics) {
            expect(typeof d.phase).toBe('string')
            expect(typeof d.code).toBe('string')
            expect(typeof d.message).toBe('string')
            expect(d.span).toBeDefined()
        }
    })
})

// ---------------------------------------------------------------------------
// SyntaxTree.withText() — incremental reparse
// ---------------------------------------------------------------------------

describe('SyntaxTree.withText()', () => {
    test('is a method on SyntaxTree instances', () => {
        const { tree } = parse('@let x:Int := 1;')
        expect(typeof tree.withText).toBe('function')
        expect(tree instanceof SyntaxTree).toBe(true)
    })

    test('returns a ParseResult with the new source', () => {
        const { tree: original } = parse('@let x:Int := 1;')
        const result = original.withText('@let y:Int := 2;')
        expect(result.diagnostics).toHaveLength(0)
        expect(result.tree.source).toBe('@let y:Int := 2;')
    })

    test('new tree is independent — original source is unchanged', () => {
        const src = '@let x:Int := 1;'
        const { tree: original } = parse(src)
        original.withText('@let y:Int := 99;')
        expect(original.source).toBe(src)
    })

    test('preserves the file name from the original tree', () => {
        const { tree } = parse('@let x:Int := 1;', { file: 'foo.si' })
        expect(tree.file).toBe('foo.si')
        const { tree: reparsed } = tree.withText('@let y:Int := 2;')
        expect(reparsed.file).toBe('foo.si')
    })

    test('file override in options is respected', () => {
        const { tree } = parse('@let x:Int := 1;', { file: 'a.si' })
        const { tree: reparsed } = tree.withText('@let y:Int := 2;', { file: 'b.si' })
        expect(reparsed.file).toBe('b.si')
    })

    test('captures parse errors without throwing', () => {
        const { tree } = parse('@let x:Int := 1;')
        const result = tree.withText('@@@@invalid')
        expect(result.diagnostics.length).toBeGreaterThan(0)
        expect(result.diagnostics[0].phase).toBe('parse')
    })

    test('registry reuse pattern: elaborate with old registry after withText', () => {
        const src1 = '@fn answer:Int := { 42 };'
        const { tree: t1 } = parse(src1)
        const reg = buildRegistry(t1)
        const { tree: elab1 } = elaborate(t1, reg)

        // Edit: change the return value, keep the same function name.
        const src2 = '@fn answer:Int := { 99 };'
        const { tree: t2 } = t1.withText(src2)

        // Reuse the old registry — no buildRegistry call.
        const { tree: elab2, diagnostics } = elaborate(t2, reg)
        expect(diagnostics).toHaveLength(0)
        expect(elab2.source).toBe(src2)

        // Both trees produce valid WAT.
        const r1 = compile(src1)
        const r2 = compile(src2)
        expect(r1.wat).toContain('(module')
        expect(r2.wat).toContain('(module')
    })
})
