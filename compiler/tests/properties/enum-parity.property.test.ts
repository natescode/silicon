/**
 * @enum / @type_sum parity tests — partial WS 3 of Stage 0 Cleanup Plan.
 *
 * `@enum` is the modern name for today's payload-free `@type_sum`.
 * Both keywords must produce identical compiled output so existing code
 * keeps working while new code adopts the cleaner spelling.
 *
 * Payload-bearing sum types (the `@type` form in the cleanup plan)
 * require grammar work and land in a follow-up commit.
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

describe('@enum / @type_sum parity', () => {
    test('multi-variant enum compiles to the same WAT as @type_sum', () => {
        const enumSrc    = '@enum Color := Red | Green | Blue;'
        const sumSrc     = '@type_sum Color := Red | Green | Blue;'
        const enumWat    = userPart(compileToWatString(enumSrc))
        const sumWat     = userPart(compileToWatString(sumSrc))
        expect(enumWat).toBe(sumWat)
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

    test('enum without params (schema rule from @type_sum applies)', () => {
        let err = ''
        try { compileToWatString('@enum Color x:Int := Red | Green;') }
        catch (e) { err = String(e) }
        expect(err).toMatch(/does not accept parameters|@enum|param/i)
    })
})
