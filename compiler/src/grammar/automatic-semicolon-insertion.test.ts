// SPDX-License-Identifier: MIT
/**
 * ADR 0026: conservative automatic semicolon insertion.
 *
 * ASI is parser-position only: newline may terminate complete top-level/block
 * items, but expression continuations and trailing block values keep their
 * existing grammar meaning.
 */

import { describe, expect, test } from 'bun:test'
import { parseToAst } from '../parser/handwritten/parser'

const L = (...lines: string[]) => lines.join('\n')
const BS = '\\\\'

const parses = (src: string): boolean => {
    try { parseToAst(src); return true } catch { return false }
}

describe('ADR 0026 automatic semicolon insertion', () => {
    test('top-level items may be newline terminated', () => {
        const ast = parseToAst(L(
            `${BS} add (Int, Int) -> Int`,
            '@fn add a, b := a + b',
            '',
            'answer := add(20, 22)',
            'print_int(answer)',
        ))
        expect(ast.elements).toHaveLength(3)
        expect(ast.elements.map((e: any) => e.type)).toEqual(['Definition', 'Definition', 'FunctionCall'])
    })

    test('EOF terminates a complete top-level item', () => {
        const ast = parseToAst('answer := 42')
        expect(ast.elements).toHaveLength(1)
        expect((ast.elements[0] as any).type).toBe('Definition')
    })

    test('block newlines terminate interior items but not trailing block value', () => {
        const ast = parseToAst(L(
            `${BS} score (Int) -> Int`,
            '@fn score n := {',
            '    doubled := n * 2',
            '    capped := @if(doubled > 100, { 100 }, { doubled })',
            '    capped',
            '}',
        ))
        const block = (ast.elements[0] as any).binding.expression
        expect(block.type).toBe('Block')
        expect(block.items).toHaveLength(2)
        expect(block.trailing.type).toBe('Namespace')
        expect(block.trailing.path).toEqual(['capped'])
    })

    test('multiline calls and binary continuations remain one expression', () => {
        expect(parses(L(
            'total := add(',
            '    subtotal,',
            '    tax',
            ')',
            '',
            'ready := subtotal',
            '    + tax',
            '    + shipping',
        ))).toBe(true)
    })

    test('bodyless extern signatures may terminate at newline', () => {
        const ast = parseToAst(L(
            `${BS} @extern puts (String) -> Int`,
            `${BS} @extern clock () -> Int`,
        ))
        expect(ast.elements).toHaveLength(2)
        expect(ast.elements.map((e: any) => e.keyword)).toEqual(['@extern', '@extern'])
    })

    test('call opener cannot move to the next line', () => {
        expect(parses(L(
            'print',
            "('hello')",
        ))).toBe(false)
    })
})
