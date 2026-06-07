/**
 * Payload sum types (`@type X := $Variant field Type | ...`) — Phase −1.A
 * of the bootstrap plan; the WS 3 acceptance gate from
 * docs/stage0-cleanup-plan.html §3.4.
 *
 * Runs the canonical Shape example end-to-end: the program compiles, the
 * generated WAT instantiates under wabt, area() destructures correctly,
 * and the result is 99 (5*5*3 + 4*6).
 *
 * Also covers:
 *   - $Variant constructor functions emit the expected pad-to-max layout.
 *   - Tag globals (Shape__Circle_tag, ...) are emitted in source order.
 *   - @match destructure binds fields as locals and reads them via i32.load
 *     at the right offsets.
 */

import { test, expect, describe } from 'bun:test'
import wabt from 'wabt'
import { compileToWatString } from './_compile'

function compile(src: string): string { return compileToWatString(src) }

async function instantiate(wat: string, imports: Record<string, any> = {}): Promise<any> {
    const w = await wabt()
    const mod = w.parseWat('main.wat', wat)
    mod.resolveNames()
    mod.validate()
    const { buffer } = mod.toBinary({})
    const inst = await WebAssembly.instantiate(buffer, {
        env: { print: () => {}, read: () => 0 },
        ...imports,
    })
    return inst.instance.exports
}

describe('@type payload sum types', () => {
    test('declaration emits one tag global per variant (auto-numbered)', () => {
        const wat = compile('@type Shape := $Circle r Int | $Rectangle w Int, h Int;')
        expect(wat).toContain('(global $Shape__Circle_tag i32 (i32.const 0))')
        expect(wat).toContain('(global $Shape__Rectangle_tag i32 (i32.const 1))')
    })

    test('constructor function uses pad-to-max layout', () => {
        // max_fields = 2 → record bytes = 4 + 4*2 = 12.
        const wat = compile('@type Shape := $Circle r Int | $Rectangle w Int, h Int;')
        // Circle has 1 field — record allocates 12 bytes, stores tag, field, zero pad.
        expect(wat).toContain('(local.set $__rec (call $alloc (i32.const 12)))')
        expect(wat).toMatch(/\(i32\.store \(local\.get \$__rec\) \(i32\.const 0\)\)/)
        // Trailing slot zero-init.
        expect(wat).toMatch(/\(i32\.store \(i32\.add \(local\.get \$__rec\) \(i32\.const 8\)\) \(i32\.const 0\)\)/)
    })

    test('single-variant @type allocates 4 + 4*max bytes correctly', () => {
        // Only one variant with 3 fields → max_fields=3 → 16 bytes.
        const wat = compile('@type Triple := $T x Int, y Int, z Int;')
        expect(wat).toContain('(local.set $__rec (call $alloc (i32.const 16)))')
    })

    test('@match destructure binds each field via i32.load at (idx+1)*4', () => {
        const src = [
            '@type Shape := $Circle r Int | $Rectangle w Int, h Int;',
            '\\\\ area (Shape) -> Int',
            'area s := {',
            '  @match(s,',
            '    $Circle r,       { r * r * 3 },',
            '    $Rectangle w, h, { w * h })',
            '};',
        ].join('\n')
        const wat = compile(src)
        expect(wat).toContain('(local $r i32)')
        expect(wat).toContain('(local $w i32)')
        expect(wat).toContain('(local $h i32)')
        // Tag comparison
        expect(wat).toMatch(/\(i32\.eq \(i32\.load \(local\.get \$s\)\) \(i32\.const 0\)\)/)
        expect(wat).toMatch(/\(i32\.eq \(i32\.load \(local\.get \$s\)\) \(i32\.const 1\)\)/)
        // r loaded from offset 4, w from offset 4, h from offset 8.
        expect(wat).toMatch(/\(local\.set \$r \(i32\.load \(i32\.add \(local\.get \$s\) \(i32\.const 4\)\)\)\)/)
        expect(wat).toMatch(/\(local\.set \$h \(i32\.load \(i32\.add \(local\.get \$s\) \(i32\.const 8\)\)\)\)/)
    })

    test('Shape example from cleanup-plan §3.4 runs end-to-end and returns 99', async () => {
        const src = [
            '@type Shape := $Circle r Int | $Rectangle w Int, h Int;',
            '\\\\ area (Shape) -> Int',
            'area s := {',
            '  @match(s,',
            '    $Circle r,       { r * r * 3 },',
            '    $Rectangle w, h, { w * h })',
            '};',
            '\\\\ main () -> Int',
            'main := {',
            '  @mut c := Circle(5);',
            '  @mut r := Rectangle(4, 6);',
            '  area(c) + area(r)',
            '};',
            '@export main;',
        ].join('\n')
        const wat = compile(src)
        const exports = await instantiate(wat)
        expect(exports.main()).toBe(99)
    })

    test('arity mismatch on constructor is a type error', () => {
        let err = ''
        try {
            compile([
                '@type Shape := $Circle r Int | $Rectangle w Int, h Int;',
                'bad := { Circle(1, 2) };',     // Circle takes 1 arg, not 2
            ].join('\n'))
        } catch (e) { err = String(e) }
        expect(err).toMatch(/expects 1 argument|got 2/)
    })

    test('constructor returns the sum type (callable from functions typed Shape)', () => {
        // If the constructor didn't return Shape, this would fail type-check.
        const wat = compile([
            '@type Shape := $Circle r Int | $Rectangle w Int, h Int;',
            '\\\\ area (Shape) -> Int',
            'area s := { @match(s, $Circle r, { r }, $Rectangle w, h, { w }) };',
            '\\\\ go () -> Int',
            'go := { area(Circle(7)) };',
        ].join('\n'))
        expect(wat).toContain('(call $area (call $Circle (i32.const 7)))')
    })
})
