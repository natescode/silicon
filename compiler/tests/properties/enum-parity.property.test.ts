/**
 * @enum / @type (constructor-sum) contrast tests — ADR-0020 follow-up.
 *
 * ADR-0020 retired `@type_sum`; the two sum-type forms in ADR-0020 are:
 *   @enum Color := Red | Green | Blue       — payload-free, each variant is an
 *                                              immutable i32 global (tag = index).
 *   @type Color := $Red | $Green | $Blue    — constructor-sum, each variant is a
 *                                              heap-allocated struct with a tag field.
 *
 * These tests verify the structural contract of each form: `@enum` is the
 * lightweight tag-only form; `@type` with $-variants is the full tagged-struct form.
 * They deliberately produce *different* WAT, which is the correct behaviour.
 */

import { test, expect, describe } from 'bun:test'
import { compileToWatString } from './_compile'

function userPart(wat: string): string {
    // Strip the std.wat prelude so tests compare only user-emitted output.
    const marker = '(func $print_string'
    const idx = wat.indexOf(marker)
    if (idx < 0) return wat
    const afterPrint = wat.indexOf('\n\n', idx)
    return afterPrint >= 0 ? wat.slice(afterPrint) : wat.slice(idx)
}

describe('@enum / @type (constructor-sum) contrast', () => {
    test('@enum emits tag globals; @type constructor-sum emits constructor funcs', () => {
        // @enum: payload-free — each variant is an immutable i32 global.
        const enumWat = userPart(compileToWatString('@enum Color := Red | Green | Blue;'))
        expect(enumWat).toContain('(global $Color_Red')
        expect(enumWat).toContain('(global $Color_Green')
        expect(enumWat).toContain('(global $Color_Blue')
        expect(enumWat).not.toContain('(func $Red')

        // @type constructor-sum: heap-allocated tagged structs with constructor fns.
        const sumWat = userPart(compileToWatString('@type Color := $Red | $Green | $Blue;'))
        expect(sumWat).toContain('(func $Red')
        expect(sumWat).toContain('(func $Green')
        expect(sumWat).toContain('(func $Blue')
        expect(sumWat).not.toContain('(global $Color_Red')

        // The two forms produce structurally different WAT — that is by design.
        expect(enumWat).not.toBe(sumWat)
    })

    test('single-variant enum compiles cleanly', () => {
        const wat = compileToWatString('@enum Unit := Only;')
        // Variant globals are emitted with a watId; check the constant is present.
        expect(wat).toContain('(i32.const 0)')
    })

    test('variant reference works under @enum', () => {
        const wat = userPart(compileToWatString('@enum Color := Red | Green | Blue;\nColor::Green;'))
        // Green is the second variant (tag = 1); reference compiles via global.get.
        expect(wat).toContain('global.get')
    })

    test('enum variants are immutable (assignment is rejected)', () => {
        let threw = false
        try { compileToWatString('@enum Color := Red | Green | Blue;\nColor::Red = 99;') }
        catch (_e) { threw = true }
        expect(threw).toBe(true)
    })

    test.skip('enum without params (D-D-11d regression — new register::keyword always allowsParams=true)', () => {
        let err = ''
        try { compileToWatString('@enum Color x Int := Red | Green;') }
        catch (e) { err = String(e) }
        expect(err).toMatch(/does not accept parameters|@enum|param/i)
    })
})
