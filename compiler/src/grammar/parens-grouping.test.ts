// SPDX-License-Identifier: MIT
/**
 * Parens as optional grouping for param lists — see
 * `docs/parens-optional-grouping.md`.
 *
 * Proves both function-definition param lists and `$fn` type annotations
 * accept an optional paren-wrapped form that produces an AST identical
 * to the bare form.  The disambiguation regression test
 * ("multi-callback") is the one that *only* parses correctly with the
 * paren form — before this revision the inner sigilFnParams rule
 * greedy-consumed across the outer param's comma.
 */

import { test, expect, describe } from 'bun:test'
import parse from '../parser'
import addToAstSemantics from '../ast/toAst'
import siliconGrammar from '../grammar/SiliconGrammar'

function parseSrc(src: string): any {
    return addToAstSemantics(siliconGrammar)(parse(src)).toAst() as any
}

function parseOk(src: string): boolean {
    try { parse(src); return true } catch { return false }
}

describe('parens-optional-grouping: function definitions', () => {
    test('paren form `@fn name:R (a:T, b:U) := body` parses with 2 params', () => {
        const ast = parseSrc(`@fn add:Int (a:Int, b:Int) := 0;`)
        expect(ast.elements[0].params).toHaveLength(2)
        expect(ast.elements[0].params[0].name).toBe('a')
        expect(ast.elements[0].params[1].name).toBe('b')
    })

    test('paren form `@fn name:R () := body` parses with 0 params', () => {
        const ast = parseSrc(`@fn nullary:Int () := 0;`)
        expect(ast.elements[0].params).toHaveLength(0)
    })

    test('paren single-param `@fn name:R (a:T) := body`', () => {
        const ast = parseSrc(`@fn id:Int (a:Int) := a;`)
        expect(ast.elements[0].params).toHaveLength(1)
    })

    test('bare and paren forms produce shape-equivalent ASTs', () => {
        const bare = parseSrc(`@fn add:Int a:Int, b:Int := 0;`)
        const paren = parseSrc(`@fn add:Int (a:Int, b:Int) := 0;`)
        // Param shapes should match (same names + type annotations).
        expect(bare.elements[0].params.map((p: any) => p.name))
            .toEqual(paren.elements[0].params.map((p: any) => p.name))
        expect(bare.elements[0].params.map((p: any) => p.typeAnnotation.typename))
            .toEqual(paren.elements[0].params.map((p: any) => p.typeAnnotation.typename))
    })
})

describe('parens-optional-grouping: $fn type annotations', () => {
    test('paren form `:$fn _:R (_:T)` parses with 1 param slot', () => {
        const ast = parseSrc(`@fn run cb:$fn _:Int (_:Int) := 0;`)
        const ann = ast.elements[0].params[0].typeAnnotation
        expect(ann.typename).toBe('$fn')
        expect(ann.fnReturn.typeAnnotation.typename).toBe('Int')
        expect(ann.fnParams).toHaveLength(1)
    })

    test('paren-empty `:$fn _:R ()` parses as nullary fn type', () => {
        const ast = parseSrc(`@fn run cb:$fn _:Int () := 0;`)
        const ann = ast.elements[0].params[0].typeAnnotation
        expect(ann.typename).toBe('$fn')
        expect(ann.fnParams).toHaveLength(0)
    })

    test('paren n-ary `:$fn _:R (_:T1, _:T2, _:T3)`', () => {
        const ast = parseSrc(`@fn run cb:$fn _:Int (_:Int, _:Float, _:Bool) := 0;`)
        const ann = ast.elements[0].params[0].typeAnnotation
        expect(ann.fnParams).toHaveLength(3)
    })
})

describe('parens-optional-grouping: multi-callback disambiguation (regression)', () => {
    test('multi-callback with inner parens: outer fn has 2 params, each a 1-arg $fn', () => {
        // Before this revision the inner sigilFnParams greedy-consumed
        // `_:Int, b:$fn _:Bool _:Float`, leaving the outer with one
        // mis-typed param.  Parens around the inner type close the list.
        const ast = parseSrc(`@fn dispatch a:$fn _:Int (_:Int), b:$fn _:Bool (_:Float) := 0;`)
        const params = ast.elements[0].params
        expect(params).toHaveLength(2)
        expect(params[0].name).toBe('a')
        expect(params[1].name).toBe('b')
        expect(params[0].typeAnnotation.typename).toBe('$fn')
        expect(params[1].typeAnnotation.typename).toBe('$fn')
        expect(params[0].typeAnnotation.fnParams).toHaveLength(1)
        expect(params[1].typeAnnotation.fnParams).toHaveLength(1)
        // Inner $fn return types differ (Int vs Bool) — confirms each
        // type was parsed independently.
        expect(params[0].typeAnnotation.fnReturn.typeAnnotation.typename).toBe('Int')
        expect(params[1].typeAnnotation.fnReturn.typeAnnotation.typename).toBe('Bool')
    })

    test('multi-callback with outer parens too: same shape', () => {
        const ast = parseSrc(`@fn dispatch (a:$fn _:Int (_:Int), b:$fn _:Bool (_:Float)) := 0;`)
        const params = ast.elements[0].params
        expect(params).toHaveLength(2)
        expect(params[0].typeAnnotation.fnReturn.typeAnnotation.typename).toBe('Int')
        expect(params[1].typeAnnotation.fnReturn.typeAnnotation.typename).toBe('Bool')
    })
})

describe('parens-optional-grouping: backward compatibility', () => {
    test('existing bare function definitions still parse', () => {
        expect(parseOk(`@fn add:Int a:Int, b:Int := a + b;`)).toBe(true)
    })

    test('existing nullary bare definitions still parse', () => {
        expect(parseOk(`@fn nullary:Int := 0;`)).toBe(true)
    })

    test('existing bare $fn types still parse', () => {
        expect(parseOk(`@let cb:$fn _:Int _:Int := 0;`)).toBe(true)
    })

    test('existing nullary bare $fn types still parse', () => {
        expect(parseOk(`@let thunk:$fn _:Int := 0;`)).toBe(true)
    })
})
