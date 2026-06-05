// SPDX-License-Identifier: MIT
/**
 * CaaS Phase 0.5 — SemanticModel tests (CaaS-2, CaaS-3, CaaS-6).
 *
 * Verifies:
 * - typeOf(node) returns the inferred SiliconType (CaaS-2)
 * - symbolAt(node) returns the Symbol for a Namespace reference (CaaS-3)
 * - referencesTo(symbol) returns all reference nodes (CaaS-3)
 * - diagnosticsIn(range) filters by source span (CaaS-6)
 * - allDiagnostics contains type errors as Diagnostic records (CaaS-6)
 * - Compiler core produces no stdout/stderr (validated by running typecheck
 *   without touching console — no special hook needed; the absence of
 *   console.* calls in the pipeline is enforced by grep in CI).
 */

import { expect, test, describe } from 'bun:test'
import typecheck from './typechecker'
import { typeEquals, TypeInt, TypeFloat, TypeBool } from './types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIntLiteral(v: string): any {
    return { type: 'IntLiteral', value: v, base: 'decimal' }
}

function makeFloatLiteral(v: string): any {
    return { type: 'FloatLiteral', value: v }
}

function makeBoolLiteral(v: boolean): any {
    return { type: 'BooleanLiteral', value: v }
}

function makeNamespace(path: string[]): any {
    return { type: 'Namespace', path }
}

function makeLetDef(name: string, binding: any): any {
    return {
        type: 'Definition',
        keyword: '@global',
        name: { type: 'TypedIdentifier', name },
        params: [],
        binding: { type: 'Binding', expression: binding },
    }
}

function makeAssign(path: string[], value: any): any {
    return {
        type: 'Assignment',
        target: { type: 'Namespace', path },
        value,
    }
}

function makeProgram(...elements: any[]): any {
    return { type: 'Program', elements }
}

// ---------------------------------------------------------------------------
// CaaS-2: typeOf
// ---------------------------------------------------------------------------

describe('CaaS-2: typeOf', () => {
    test('typeOf returns Int for an IntLiteral', () => {
        const lit = makeIntLiteral('42')
        const prog = makeProgram(lit)
        const { semanticModel } = typecheck(prog)
        const t = semanticModel.typeOf(lit)
        expect(t).toBeDefined()
        expect(typeEquals(t!, TypeInt)).toBe(true)
    })

    test('typeOf returns Float for a FloatLiteral', () => {
        const lit = makeFloatLiteral('3.14')
        const prog = makeProgram(lit)
        const { semanticModel } = typecheck(prog)
        const t = semanticModel.typeOf(lit)
        expect(t).toBeDefined()
        expect(typeEquals(t!, TypeFloat)).toBe(true)
    })

    test('typeOf returns Bool for a BooleanLiteral', () => {
        const lit = makeBoolLiteral(true)
        const prog = makeProgram(lit)
        const { semanticModel } = typecheck(prog)
        const t = semanticModel.typeOf(lit)
        expect(t).toBeDefined()
        expect(typeEquals(t!, TypeBool)).toBe(true)
    })

    test('node.inferredType backward-compat stamp is still populated', () => {
        const lit = makeIntLiteral('7')
        const prog = makeProgram(lit)
        typecheck(prog)
        expect(typeEquals((lit as any).inferredType, TypeInt)).toBe(true)
    })
})

// ---------------------------------------------------------------------------
// CaaS-3: symbolAt + referencesTo
// ---------------------------------------------------------------------------

describe('CaaS-3: symbolAt and referencesTo', () => {
    test('symbolAt resolves a Namespace reference to its definition', () => {
        const defNode = makeLetDef('count', makeIntLiteral('0'))
        const ref = makeNamespace(['count'])
        const prog = makeProgram(defNode, ref)
        const { semanticModel } = typecheck(prog)

        const sym = semanticModel.symbolAt(ref)
        expect(sym).toBeDefined()
        expect(sym!.name).toBe('count')
        expect(sym!.kind).toBe('variable')
        expect(sym!.definitionNode).toBe(defNode)
        expect(typeEquals(sym!.type!, TypeInt)).toBe(true)
    })

    test('symbolNamed looks up by name directly', () => {
        const defNode = makeLetDef('x', makeIntLiteral('1'))
        const prog = makeProgram(defNode)
        const { semanticModel } = typecheck(prog)

        const sym = semanticModel.symbolNamed('x')
        expect(sym).toBeDefined()
        expect(sym!.name).toBe('x')
        expect(sym!.kind).toBe('variable')
    })

    test('referencesTo returns all reference nodes', () => {
        const defNode = makeLetDef('val', makeIntLiteral('10'))
        const ref1 = makeNamespace(['val'])
        const ref2 = makeNamespace(['val'])
        const prog = makeProgram(defNode, ref1, ref2)
        const { semanticModel } = typecheck(prog)

        const sym = semanticModel.symbolNamed('val')
        expect(sym).toBeDefined()
        const refs = semanticModel.referencesTo(sym!)
        expect(refs.length).toBeGreaterThanOrEqual(2)
        expect(refs).toContain(ref1)
        expect(refs).toContain(ref2)
    })

    test('symbolAt returns undefined for unresolved reference', () => {
        const ref = makeNamespace(['doesNotExist'])
        const prog = makeProgram(ref)
        const { semanticModel } = typecheck(prog)
        // The typechecker emits an unbound error, so symbolAt should be undefined.
        expect(semanticModel.symbolAt(ref)).toBeUndefined()
    })
})

// ---------------------------------------------------------------------------
// CaaS-6: diagnostics as data
// ---------------------------------------------------------------------------

describe('CaaS-6: diagnostics as data', () => {
    test('allDiagnostics is empty for a well-typed program', () => {
        const prog = makeProgram(makeIntLiteral('1'))
        const { semanticModel } = typecheck(prog)
        expect(semanticModel.allDiagnostics.length).toBe(0)
    })

    test('allDiagnostics contains Diagnostic records for type errors', () => {
        const ref = makeNamespace(['unknownName'])
        const prog = makeProgram(ref)
        const { semanticModel } = typecheck(prog)
        expect(semanticModel.allDiagnostics.length).toBeGreaterThan(0)
        const d = semanticModel.allDiagnostics[0]
        expect(d.phase).toBe('typecheck')
        expect(typeof d.code).toBe('string')
        expect(d.code.startsWith('E')).toBe(true)
        expect(typeof d.message).toBe('string')
    })

    test('diagnosticsIn with undefined returns all diagnostics', () => {
        const ref = makeNamespace(['missing'])
        const prog = makeProgram(ref)
        const { semanticModel } = typecheck(prog)
        const all = semanticModel.diagnosticsIn(undefined)
        expect(all).toEqual(semanticModel.allDiagnostics)
    })

    test('diagnosticsIn filters by range (empty range returns empty)', () => {
        const ref = makeNamespace(['missing'])
        const prog = makeProgram(ref)
        const { semanticModel } = typecheck(prog)
        // A range at line 999 should not overlap any diagnostic.
        const filtered = semanticModel.diagnosticsIn({ startLine: 999, startCol: 0, endLine: 999, endCol: 100 })
        expect(filtered.length).toBe(0)
    })
})
