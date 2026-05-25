/**
 * Phase 5 grammar-revision pass.
 *
 * Proves the three new grammar additions:
 *  - `_` as a standalone discard identifier (typedIdentifier name).
 *  - `:$fn _:R` and `:$fn _:R _:T1, _:T2` — sigil function-type annotation
 *    whose shape mirrors a function definition.
 *  - Multi-arg type args with whitespace (`:Result[T, E]`) — previously
 *    silently lost to GenericParams via PEG backtracking; covered here so
 *    the regression doesn't return.
 *
 * Cleanup verification: the legacy `@stratum_operator` / `@stratum_keyword`
 * forms are no longer accepted by the grammar (covered by parse-failure
 * assertions).
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

describe('Phase 5 grammar: discard identifier `_`', () => {
    test('`_` alone is a valid identifier in name position', () => {
        const ast = parseSrc(`@fn _:Int := 42;`)
        expect(ast.elements[0].name.name).toBe('_')
    })

    test('`_:T` is a valid typed-discard parameter', () => {
        const ast = parseSrc(`@fn f x:Int, _:Int := x;`)
        expect(ast.elements[0].params[1].name).toBe('_')
    })

    test('`_foo` (underscore-prefixed normal identifier) still works', () => {
        // The existing identifier_underscoreStart rule covers `_foo`.
        // Discard `_` is ordered before it via PEG; this confirms both alts coexist.
        const ast = parseSrc(`@fn _foo:Int := 42;`)
        expect(ast.elements[0].name.name).toBe('_foo')
    })
})

describe('Phase 5 grammar: `$fn` sigil function-type annotation', () => {
    test('nullary fn type `:$fn _:Int`', () => {
        const ast = parseSrc(`@let x:$fn _:Int := 42;`)
        const ann = ast.elements[0].name.typeAnnotation
        expect(ann.typename).toBe('$fn')
        expect(ann.fnReturn.name).toBe('_')
        expect(ann.fnReturn.typeAnnotation.typename).toBe('Int')
        expect(ann.fnParams).toEqual([])
    })

    test('unary fn type `:$fn _:R _:T`', () => {
        const ast = parseSrc(`@let f:$fn _:Int _:Bool := 0;`)
        const ann = ast.elements[0].name.typeAnnotation
        expect(ann.typename).toBe('$fn')
        expect(ann.fnReturn.typeAnnotation.typename).toBe('Int')
        expect(ann.fnParams).toHaveLength(1)
        expect(ann.fnParams[0].typeAnnotation.typename).toBe('Bool')
    })

    test('n-ary fn type `:$fn _:R _:T1, _:T2, _:T3`', () => {
        const ast = parseSrc(`@let f:$fn _:Int _:Int, _:Float, _:Bool := 0;`)
        const ann = ast.elements[0].name.typeAnnotation
        expect(ann.fnParams).toHaveLength(3)
        expect(ann.fnParams.map((p: any) => p.typeAnnotation.typename)).toEqual(['Int', 'Float', 'Bool'])
    })

    test('fn type mirrors function-definition shape — same params syntax', () => {
        // Side-by-side: a function definition and the type annotation of a
        // value that would hold a reference to it.  The param-list layout
        // is identical.
        const fnSrc  = `@fn add:Int a:Int, b:Int := a + b;`
        const refSrc = `@let r:$fn _:Int _:Int, _:Int := 0;`
        // Both must parse cleanly.  This is the structural regularity
        // assertion the design hangs on.
        expect(parseOk(fnSrc)).toBe(true)
        expect(parseOk(refSrc)).toBe(true)
    })
})

describe('Phase 5 grammar: multi-arg type args tolerate whitespace', () => {
    test('`Result[T, E]` (with space) captures both type args', () => {
        const ast = parseSrc(`@type Result[T, E] := $Ok value:T | $Err error:E;`)
        // The @type declaration itself uses GenericParams, not typeArgs.
        // Multi-arg case for typeArgs is exercised by the helpers below.
        expect(ast.elements[0].generics.params).toEqual(['T', 'E'])
    })

    test('Result[Int, Int] annotation captures typeArgs (regression test)', () => {
        const ast = parseSrc(`@fn give:Result[Int, Int] := 0;`)
        const ann = ast.elements[0].name.typeAnnotation
        expect(ann.typename).toBe('Result')
        expect(ann.typeArgs).toHaveLength(2)
        expect(ann.typeArgs.map((a: any) => a.name)).toEqual(['Int', 'Int'])
    })

    test('Pair[A, B] in a parameter annotation captures typeArgs', () => {
        const ast = parseSrc(`@fn f x:Pair[A, B] := x;`)
        const ann = ast.elements[0].params[0].typeAnnotation
        expect(ann.typename).toBe('Pair')
        expect(ann.typeArgs).toHaveLength(2)
    })
})

describe('Phase 5 grammar: legacy @stratum_* forms removed', () => {
    test('`@stratum_operator` no longer parses', () => {
        expect(parseOk(`@stratum_operator Plus ('+', Node) = { };`)).toBe(false)
    })

    test('`@stratum_keyword` no longer parses', () => {
        expect(parseOk(`@stratum_keyword Foo ('@foo', Node) = { };`)).toBe(false)
    })

    test('Unified `@stratum X := { ... }` still parses', () => {
        expect(parseOk(`@stratum MyOp := { &Compiler::register::operator '+'; };`)).toBe(true)
    })
})
