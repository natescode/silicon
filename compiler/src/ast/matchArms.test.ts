// SPDX-License-Identifier: MIT
/**
 * Tests for `@match` arm normalization (flat, function-call form).
 *
 * `@match(disc, pat, { body }, pat, { body }, …)` — alternating pattern / body
 * arguments, each body a `{ … }` block.  normalizeMatchArgs expands `|`
 * alternation into the `[disc, pat, body, …]` shape the match lowerer consumes;
 * the old infix `pattern => body` arm form was removed.
 */

import { test, expect, describe } from 'bun:test'
import { normalizeMatchArgs } from './matchArms'

// Tiny AST builders — keeps the tests readable.
const id = (name: string) => ({ type: 'Namespace', path: [name] })
const intLit = (v: number) => ({ type: 'IntLiteral', value: String(v) })
const variant = (name: string, ...fields: string[]) => ({
    type: 'VariantDecl', name, fields: fields.map(f => ({ name: f })),
})
const block = (body: any) => ({ type: 'Block', statements: [], value: body })
const alt = (l: any, r: any) => ({ type: 'BinaryOp', operator: '|', left: l, right: r })
const arrow = (l: any, r: any) => ({ type: 'BinaryOp', operator: '=>', left: l, right: r })

describe('normalizeMatchArgs — flat form', () => {
    test('a plain flat form passes through unchanged', () => {
        const args = [id('disc'), variant('Some', 'v'), block(id('v')), variant('None'), block(intLit(0))]
        expect(normalizeMatchArgs(args)).toEqual(args)
    })

    test('a block body containing any expression is one opaque argument', () => {
        // `{ 0 - 1 }` is a single Block arg — no precedence interaction at all.
        const body = block({ type: 'BinaryOp', operator: '-', left: intLit(0), right: intLit(1) })
        const args = [id('disc'), variant('Ok', 'v'), block(id('v')), variant('Err', 'e'), body]
        expect(normalizeMatchArgs(args)).toEqual(args)
    })

    test('a trailing default arg (odd count) is preserved verbatim', () => {
        const args = [id('disc'), variant('Some', 'v'), block(id('v')), block(intLit(0))]
        expect(normalizeMatchArgs(args)).toEqual(args)
    })

    test('pattern alternation expands to multiple arms sharing the body', () => {
        // disc, $Red | $Green, { 'warm' }, $Blue, { 'cool' }
        const red = variant('Red'), green = variant('Green'), blue = variant('Blue')
        const warm = block(id('warm')), cool = block(id('cool'))
        const out = normalizeMatchArgs([id('disc'), alt(red, green), warm, blue, cool])
        expect(out).toEqual([id('disc'), red, warm, green, warm, blue, cool])
    })

    test('three-way alternation', () => {
        const a = variant('A'), b = variant('B'), c = variant('C'), d = variant('D')
        const x = block(id('x')), y = block(id('y'))
        const out = normalizeMatchArgs([id('disc'), alt(alt(a, b), c), x, d, y])
        expect(out).toEqual([id('disc'), a, x, b, x, c, x, d, y])
    })

    test('a leftover `pattern => body` arm throws a clear migration error', () => {
        // `$Ok v => v` parses to a `=>` BinaryOp in the pattern slot under flat
        // precedence — must fail loudly, never silently mis-lower.
        const args = [id('disc'), arrow(variant('Ok', 'v'), id('v'))]
        expect(() => normalizeMatchArgs(args)).toThrow(/no longer uses the .* => .* arm form|block argument/)
    })
})
