// SPDX-License-Identifier: MIT
/**
 * Grammar fixtures for the signature-lines surface (docs/signature-lines.md).
 *
 * Parse-level: asserts the NEW syntax parses and the OLD inline-type / $fn /
 * return-type-on-name forms are rejected. Exercises the hand-written parser
 * directly (ohm removed) — `matches` means "parses without error".
 */

import { describe, test, expect } from 'bun:test'
import { parseToAst } from '../parser/handwritten/parser'

const matches = (src: string): boolean => {
    try { parseToAst(src); return true } catch { return false }
}
const L = (...lines: string[]) => lines.join('\n')
const BS = '\\\\' // two backslashes — the signature sigil

describe('signature-lines grammar — NEW syntax parses', () => {
    test('attached signature + bare-param function', () => {
        expect(matches(L(`${BS} apply (Int, Int) -> Int`, '@fn apply a, b := { a + b };'))).toBe(true)
    })
    test('function with no signature (inference)', () => {
        expect(matches('@fn add a, b := { a + b };')).toBe(true)
    })
    test('higher-order param via parenthesised domain', () => {
        expect(matches(L(`${BS} run ((Int) -> Bool, Int) -> Void`, '@fn run cb, x := 0;'))).toBe(true)
    })
    test('nullary domain () -> T', () => {
        expect(matches(L(`${BS} now () -> Int`, '@fn now  := 0;'))).toBe(true)
    })
    test('generic signature with [T, U]', () => {
        expect(matches(L(`${BS} map[T, U] ((T) -> U, Vec[T]) -> Vec[U]`, '@fn map f, xs := { f };'))).toBe(true)
    })
    test('struct fields by juxtaposition (no colon)', () => {
        expect(matches('@type Rect := { w Int, h Int };')).toBe(true)
    })
    test('sum-type variant payloads by juxtaposition', () => {
        expect(matches('@type Shape := $Circle r Int | $Rectangle w Int, h Int;')).toBe(true)
    })
    test('extern via `\\ @extern` signature line', () => {
        expect(matches(`${BS} @extern InitWindow (Int, Int, String) -> Void;`)).toBe(true)
    })
    test('multiple `\\ @extern` lines', () => {
        expect(matches(L(`${BS} @extern InitWindow (Int, Int, String) -> Void;`, `${BS} @extern IsKeyDown (Int) -> Bool;`))).toBe(true)
    })
})

describe('signature-lines grammar — OLD syntax rejected', () => {
    // NB: these inputs are intentionally OLD syntax (the snippet codemod must
    // not be re-run over this block — it would migrate them and break the point).
    test('inline param types (name:Type) no longer parse', () => {
        expect(matches('@fn add a:Int, b:Int := a;')).toBe(false)
    })
    test('$fn inline function type no longer parses', () => {
        expect(matches('@fn run cb:$fn _:Int := 0;')).toBe(false)
    })
    test('return-type-on-name (@fn name:Ret) no longer parses', () => {
        expect(matches('@fn add:Int a, b := a;')).toBe(false)
    })
    // ADR-0020 retired the `&`-call sigil, `@extern {…}` / `@interface {…}` brace
    // blocks, the explicit storage keywords, and `&@as` ascription.
    test('& call sigil no longer parses', () => {
        expect(matches('y := &add 1, 2;')).toBe(false)
    })
    test('@extern { … } brace block no longer parses', () => {
        expect(matches(L('@extern {', `  ${BS} InitWindow (Int) -> Void`, '}'))).toBe(false)
    })
    test('@interface { … } brace block no longer parses', () => {
        expect(matches(L('@interface Show[T] {', `  ${BS} show T -> String`, '}'))).toBe(false)
    })
    test('&@as ascription no longer parses', () => {
        expect(matches('x := &@as Int, 0;')).toBe(false)
    })
    test('@local / @global storage keywords no longer parse', () => {
        expect(matches('@global x := 1;')).toBe(false)
        expect(matches('@local y := 2;')).toBe(false)
    })
    test('@struct keyword no longer parses', () => {
        expect(matches('@struct Rect { w Int, h Int };')).toBe(false)
    })
})
