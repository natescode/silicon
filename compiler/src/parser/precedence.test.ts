// SPDX-License-Identifier: MIT
/**
 * Operator precedence + non-decimal integer literals.
 *
 * Silicon used to fold binary operators flat left-to-right (`2 + 3 * 4` == 20).
 * The parser now uses precedence climbing.  And the lexer used to reject prefixed
 * bases (`0x..` lexed as `0` + identifier `x..`); it now accepts hex/binary/octal.
 * Each case compiles a `probe` and runs it under the host target.
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

describe('operator precedence (climbing, left-associative)', () => {
    test('multiplicative binds tighter than additive', async () => {
        expect(await evalInt('2 + 3 * 4')).toBe(14)
        expect(await evalInt('2 * 3 + 4')).toBe(10)
        expect(await evalInt('1 + 2 * 3 - 4')).toBe(3)
    })
    test('left-associativity for same precedence', async () => {
        expect(await evalInt('10 - 2 - 3')).toBe(5)
        expect(await evalInt('20 / 2 / 5')).toBe(2)
    })
    test('parentheses override precedence', async () => {
        expect(await evalInt('(2 + 3) * 4')).toBe(20)
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
