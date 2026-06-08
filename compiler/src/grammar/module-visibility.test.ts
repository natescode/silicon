// SPDX-License-Identifier: MIT
/**
 * ADR-0024 / ADR-0020 §decision-8 amendment: the `\\` signature-line Modifier
 * set is extended with `@pub` (module visibility) and `@export` (the
 * signature-line form of the shipped `@export name;` statement). This asserts
 * the parser records the flags and that the modifier loop stays order-free and
 * LL(1)-compatible alongside the existing `@extern` modifier.
 */

import { describe, test, expect } from 'bun:test'
import { parseToAst } from '../parser/handwritten/parser'

const L = (...lines: string[]) => lines.join('\n')
const BS = '\\\\' // two backslashes — the signature sigil

function defs(src: string): any[] {
    const prog: any = parseToAst(src)
    return (prog.elements ?? [])
        .map((el: any) => el.value ?? el)
        .filter((n: any) => n.type === 'Definition')
}

describe('ADR-0024 — @pub / @export signature-line modifiers', () => {
    test('@pub sets pub:true, no export', () => {
        const [d] = defs(L(`${BS} @pub trim (Str) -> Str`, '@fn trim s := { s };'))
        expect(d.keyword).toBe('@fn')
        expect(d.name.name).toBe('trim')
        expect(d.pub).toBe(true)
        expect(d.export).toBeFalsy()
    })

    test('plain def is neither pub nor export', () => {
        const [d] = defs(L(`${BS} scan (Str) -> Str`, '@fn scan s := { s };'))
        expect(d.pub).toBeFalsy()
        expect(d.export).toBeFalsy()
    })

    test('@export modifier sets export:true and synthesizes an @export statement', () => {
        const ds = defs(L(`${BS} @export run () -> Int`, '@fn run := { 0 };'))
        expect(ds).toHaveLength(2)
        expect(ds[0].keyword).toBe('@fn')
        expect(ds[0].export).toBe(true)
        expect(ds[1].keyword).toBe('@export')
        expect(ds[1].name.name).toBe('run')
    })

    test('@pub @export are orthogonal and order-independent', () => {
        const a = defs(L(`${BS} @pub @export run () -> Int`, '@fn run := { 0 };'))
        const b = defs(L(`${BS} @export @pub run () -> Int`, '@fn run := { 0 };'))
        for (const ds of [a, b]) {
            expect(ds[0].pub).toBe(true)
            expect(ds[0].export).toBe(true)
            expect(ds[1].keyword).toBe('@export')
        }
    })

    test('@pub composes with @extern (a pub external) without an export statement', () => {
        const ds = defs(`${BS} @pub @extern host_log (Int) -> Void;`)
        expect(ds).toHaveLength(1)
        expect(ds[0].keyword).toBe('@extern')
        expect(ds[0].pub).toBe(true)
    })

    test('@extern alone is unchanged (no pub/export)', () => {
        const [d] = defs(`${BS} @extern InitWindow (Int, Int, String) -> Void;`)
        expect(d.keyword).toBe('@extern')
        expect(d.pub).toBeFalsy()
        expect(d.export).toBeFalsy()
    })

    test('@pub on a value binding (no params)', () => {
        const [d] = defs(L(`${BS} @pub MAX Int`, 'MAX := 100;'))
        expect(d.name.name).toBe('MAX')
        expect(d.pub).toBe(true)
    })
})
