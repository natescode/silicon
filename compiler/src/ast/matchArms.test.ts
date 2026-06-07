// SPDX-License-Identifier: MIT
/**
 * Tests for the @match arm-expression form normalisation.
 *
 * The new form is `@match(disc, pat => body, pat => body, …)` with
 * optional pattern alternation via `pat | pat | pat => body`.
 * normalizeMatchArgs flattens this into the legacy `[disc, pat, body, …]`
 * shape so the existing match-lowering / typechecking machinery works
 * unchanged.
 */

import { test, expect, describe } from 'bun:test'
import { normalizeMatchArgs, isArmExpressionForm } from './matchArms'

// Tiny AST builders — keeps the tests readable.
const id = (name: string) => ({ type: 'Namespace', path: [name] })
const intLit = (v: number) => ({ type: 'IntLiteral', value: String(v) })
const variant = (name: string, ...fields: string[]) => ({
    type: 'VariantDecl', name, fields: fields.map(f => ({ name: f })),
})
const arm = (pat: any, body: any) => ({ type: 'BinaryOp', operator: '=>', left: pat, right: body })
const alt = (l: any, r: any) => ({ type: 'BinaryOp', operator: '|', left: l, right: r })

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

describe('isArmExpressionForm', () => {
    test('false for an empty arg list', () => {
        expect(isArmExpressionForm([])).toBe(false)
    })

    test('false for legacy flat form', () => {
        expect(isArmExpressionForm([id('disc'), variant('Some', 'v'), id('v')])).toBe(false)
    })

    test('true if any arg uses `=>`', () => {
        expect(isArmExpressionForm([id('disc'), arm(variant('Some', 'v'), id('v'))])).toBe(true)
    })

    test('true even if only the second arg uses arm-expr (mixed)', () => {
        expect(isArmExpressionForm([
            id('disc'),
            variant('Foo'), intLit(1),                  // legacy arm
            arm(variant('Bar'), intLit(2)),             // arm-expr
        ])).toBe(true)
    })
})

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

describe('normalizeMatchArgs', () => {
    test('legacy flat form passes through unchanged', () => {
        const args = [id('disc'), variant('Some', 'v'), id('v'), variant('None'), intLit(0)]
        expect(normalizeMatchArgs(args)).toEqual(args)
    })

    test('simple arm-expr is expanded to flat form', () => {
        // disc, $Some v => v, $None => dflt
        const v = variant('Some', 'v')
        const n = variant('None')
        const out = normalizeMatchArgs([id('disc'), arm(v, id('v')), arm(n, id('dflt'))])
        expect(out).toEqual([id('disc'), v, id('v'), n, id('dflt')])
    })

    test('trailing default arg is preserved verbatim', () => {
        // disc, $Some v => v, defaultValue
        const v = variant('Some', 'v')
        const out = normalizeMatchArgs([id('disc'), arm(v, id('v')), intLit(0)])
        expect(out).toEqual([id('disc'), v, id('v'), intLit(0)])
    })

    test('pattern alternation expands to multiple arms sharing the body', () => {
        // disc, $Red | $Green => 'warm', $Blue => 'cool'
        const red = variant('Red')
        const green = variant('Green')
        const blue = variant('Blue')
        const out = normalizeMatchArgs([
            id('disc'),
            arm(alt(red, green), id('warm')),
            arm(blue, id('cool')),
        ])
        expect(out).toEqual([
            id('disc'),
            red, id('warm'),
            green, id('warm'),
            blue, id('cool'),
        ])
    })

    test('three-way pattern alternation', () => {
        // disc, $A | $B | $C => x, $D => y
        const a = variant('A'), b = variant('B'), c = variant('C'), d = variant('D')
        const out = normalizeMatchArgs([
            id('disc'),
            arm(alt(alt(a, b), c), id('x')),
            arm(d, id('y')),
        ])
        expect(out).toEqual([
            id('disc'),
            a, id('x'),
            b, id('x'),
            c, id('x'),
            d, id('y'),
        ])
    })
})
