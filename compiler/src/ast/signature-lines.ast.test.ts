// SPDX-License-Identifier: MIT
/**
 * B1 slice 2 — toAst fixtures for the signature-lines refactor.
 *
 * Parse-level: builds the AST directly (grammar + addToAstSemantics), no strata
 * load.  Verifies that an attached `\\` signature is distributed onto the bare
 * params (by position) and the name's return slot — i.e. that the new surface
 * lowers to the SAME Definition AST the old inline-type grammar produced.
 */

import { describe, test, expect } from 'bun:test'
import siliconGrammar from '../grammar/SiliconGrammar'
import addToAstSemantics from './toAst'

const sem = addToAstSemantics(siliconGrammar)
function toAst(src: string): any {
    const m = siliconGrammar.match(src)
    if (m.failed()) throw new Error(`parse failed:\n${m.message}`)
    return sem(m).toAst()
}
const defs = (src: string) => toAst(src).elements.filter((e: any) => e.type === 'Definition')
const L = (...lines: string[]) => lines.join('\n')
const BS = '\\\\'

describe('signature-lines toAst — signature distributes onto params + return', () => {
    test('attached signature → typed params + return type', () => {
        const [fn] = defs(L(`${BS} apply (Int, Int) -> Int`, '@fn apply a, b := { a + b };'))
        expect(fn.keyword).toBe('@fn')
        expect(fn.name.name).toBe('apply')
        expect(fn.name.typeAnnotation?.typename).toBe('Int')        // return type
        expect(fn.params.map((p: any) => p.name)).toEqual(['a', 'b'])
        expect(fn.params.map((p: any) => p.typeAnnotation?.typename)).toEqual(['Int', 'Int'])
    })

    test('no signature → bare params (no type annotations), for inference', () => {
        const [fn] = defs('@fn add a, b := { a + b };')
        expect(fn.params.map((p: any) => p.typeAnnotation)).toEqual([undefined, undefined])
        expect(fn.name.typeAnnotation).toBeUndefined()
    })

    test('higher-order param → fnTypeAnnotation; Void return', () => {
        const [fn] = defs(L(`${BS} run ((Int) -> Bool, Int) -> Void`, '@fn run cb, x := 0;'))
        expect(fn.name.typeAnnotation?.typename).toBe('Void')
        const cb = fn.params[0]
        expect(cb.typeAnnotation?.typename).toBe('$fn')
        expect(cb.typeAnnotation?.fnReturn?.typeAnnotation?.typename).toBe('Bool')
        expect(cb.typeAnnotation?.fnParams?.map((s: any) => s.typeAnnotation?.typename)).toEqual(['Int'])
        expect(fn.params[1].typeAnnotation?.typename).toBe('Int')
    })

    test('generic signature carries [T, U] onto the definition', () => {
        const [fn] = defs(L(`${BS} map[T, U] ((T) -> U, Vec[T]) -> Vec[U]`, '@fn map f, xs := { f };'))
        expect(fn.generics?.params).toEqual(['T', 'U'])
        expect(fn.params[1].typeAnnotation?.typename).toBe('Vec')
    })

    test('struct fields keep juxtaposed types', () => {
        const [s] = defs('@struct Rect w Int, h Int;')
        expect(s.keyword).toBe('@struct')
        expect(s.params.map((p: any) => [p.name, p.typeAnnotation?.typename])).toEqual([['w', 'Int'], ['h', 'Int']])
    })

    test('@extern block expands to one extern definition per signature', () => {
        const ds = defs(L('@extern {', `  ${BS} InitWindow (Int, Int, String) -> Void`, `  ${BS} IsKeyDown Int -> Bool`, '}'))
        expect(ds.length).toBe(2)
        expect(ds[0].keyword).toBe('@extern')
        expect(ds[0].name.name).toBe('InitWindow')
        expect(ds[0].params.map((p: any) => p.typeAnnotation?.typename)).toEqual(['Int', 'Int', 'String'])
        expect(ds[0].name.typeAnnotation?.typename).toBe('Void')
        expect(ds[1].name.name).toBe('IsKeyDown')
        expect(ds[1].params.map((p: any) => p.typeAnnotation?.typename)).toEqual(['Int'])
        expect(ds[1].name.typeAnnotation?.typename).toBe('Bool')
    })
})
