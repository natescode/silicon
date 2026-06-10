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
const bin = (operator: string, l: any, r: any) => ({ type: 'BinaryOp', operator, left: l, right: r })

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

    // Flat (left-associative, equal) operator precedence steals an arm's `=>`
    // root when the body is itself a binary expression: `$Err e => 0 - 1` parses
    // as `(($Err e => 0) - 1)`.  normalizeMatchArgs must recover the real
    // (pattern, body) so the body is the whole binary expression, not just `0`.
    test('binary-expression arm body is recovered from a stolen `=>` root', () => {
        // disc, $Ok v => v, $Err e => 0 - 1   (the Err body parsed as `(=> 0) - 1`)
        const okV = variant('Ok', 'v')
        const errE = variant('Err', 'e')
        const stolen = bin('-', arm(errE, intLit(0)), intLit(1))   // (($Err e => 0) - 1)
        const out = normalizeMatchArgs([id('disc'), arm(okV, id('v')), stolen])
        expect(out).toEqual([
            id('disc'),
            okV, id('v'),
            errE, bin('-', intLit(0), intLit(1)),                  // body = `0 - 1`
        ])
        expect(isArmExpressionForm([id('disc'), stolen])).toBe(true)
    })

    test('multi-operator binary arm body rebuilds the flat left-assoc chain', () => {
        // $Ok v => v + 1 - 2   parses as `((($Ok v => v) + 1) - 2)`
        const okV = variant('Ok', 'v')
        const stolen = bin('-', bin('+', arm(okV, id('v')), intLit(1)), intLit(2))
        const out = normalizeMatchArgs([id('disc'), stolen])
        // body = ((v + 1) - 2)
        expect(out).toEqual([id('disc'), okV, bin('-', bin('+', id('v'), intLit(1)), intLit(2))])
    })

    test('pattern alternation survives a stolen binary body', () => {
        // $Red | $Green => 1 - 1
        const red = variant('Red'), green = variant('Green')
        const stolen = bin('-', arm(alt(red, green), intLit(1)), intLit(1))
        const out = normalizeMatchArgs([id('disc'), stolen])
        expect(out).toEqual([
            id('disc'),
            red, bin('-', intLit(1), intLit(1)),
            green, bin('-', intLit(1), intLit(1)),
        ])
    })
})
