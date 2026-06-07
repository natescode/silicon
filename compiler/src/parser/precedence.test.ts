// SPDX-License-Identifier: MIT
/**
 * Expression evaluation (flat, no precedence) + non-decimal integer literals.
 *
 * BY DESIGN Silicon has NO operator precedence table: binary operators fold
 * strictly left-to-right (`2 + 3 * 4` == 20, i.e. `(2 + 3) * 4`).  Precedence is
 * expressed with parentheses.  These tests LOCK that behaviour so a precedence
 * table can't be reintroduced silently (see docs/grammar.ebnf).  The lexer also
 * accepts prefixed bases (0x/0b/0o).  Each case compiles a `probe` and runs it.
 */
import { describe, test, expect } from 'bun:test'
import { compile } from '../caas/index'

async function evalInt(expr: string): Promise<number> {
    const src = `\\\\ probe Int\n@fn probe := ${expr};\n@export probe;`
    const r = compile(src, { target: 'host', emitBinary: true })
    if (r.diagnostics.length) throw new Error(r.diagnostics.map((d: any) => d.message).join('; '))
    const mod = await WebAssembly.instantiate(r.binary as Uint8Array, { env: { print: () => {}, read: () => 0 } })
    return (mod.instance.exports as any).probe() as number
}

describe('flat left-to-right evaluation (NO precedence table — by design)', () => {
    test('operators fold strictly left-to-right, ignoring arithmetic precedence', async () => {
        expect(await evalInt('2 + 3 * 4')).toBe(20)      // ((2 + 3) * 4), NOT 14
        expect(await evalInt('1 + 2 * 3 - 4')).toBe(5)   // (((1 + 2) * 3) - 4)
        expect(await evalInt('2 * 3 + 4')).toBe(10)      // ((2 * 3) + 4)
    })
    test('same-shape left-folds', async () => {
        expect(await evalInt('10 - 2 - 3')).toBe(5)
        expect(await evalInt('20 / 2 / 5')).toBe(2)
    })
    test('parentheses are how you express precedence', async () => {
        expect(await evalInt('(2 + 3) * 4')).toBe(20)
        expect(await evalInt('2 + (3 * 4)')).toBe(14)
    })
})

describe('non-decimal integer literals', () => {
    test('hexadecimal', async () => {
        expect(await evalInt('0x4E2D')).toBe(20013)
        expect(await evalInt('0xFF')).toBe(255)
        expect(await evalInt('0x10 + 1')).toBe(17)   // literal + precedence
    })
    test('binary', async () => {
        expect(await evalInt('0b1010')).toBe(10)
    })
    test('octal', async () => {
        expect(await evalInt('0o17')).toBe(15)
    })
})
