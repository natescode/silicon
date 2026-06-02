// SPDX-License-Identifier: MIT
/**
 * Unit tests for bare-name `@use 'io';` resolution against the bundled standard
 * library.  A bare identifier (no `/`, no `.si`) resolves from the stdlib hook
 * instead of the filesystem; path-form `@use './x.si';` is unaffected.
 *
 * The stdlib hook is injected (in-memory map) so these tests touch neither the
 * real filesystem nor the inlined assets.
 */

import { test, expect, describe } from 'bun:test'
import { resolve } from 'path'
import { resolveUses, type StdlibHook } from './useResolver'

function P(p: string): string {
    return resolve('/', p)
}

/** A StdlibHook backed by an in-memory { 'io.si': source } map. */
function inMemoryStdlib(modules: Record<string, string>): StdlibHook {
    return {
        read: (rel) => modules[rel],
        has: (rel) => rel in modules,
    }
}

describe('resolveUses — bundled stdlib (bare-name @use)', () => {
    test("bare name resolves from the stdlib and is prepended", () => {
        const stdlib = inMemoryStdlib({ 'io.si': '\\\\ print (String)\n@fn print s := { 0 };' })
        const src = "@use 'io';\n&print 'hi';"
        const { source, visited } = resolveUses(src, P('main.si'), { stdlib })

        expect(visited).toEqual(['std:io.si', P('main.si')])
        const ioIdx = source.indexOf('@fn print s')
        const mainIdx = source.indexOf("&print 'hi'")
        expect(ioIdx).toBeGreaterThan(-1)
        expect(mainIdx).toBeGreaterThan(ioIdx)        // stdlib body comes first
        expect(source).not.toContain("@use 'io';")    // directive stripped
    })

    test('multiple bare names are concatenated in declaration order', () => {
        const stdlib = inMemoryStdlib({
            'option.si': '# option module\n@fn none := { 0 };',
            'slice.si': '# slice module\n@fn slice_len s := { 0 };',
        })
        const src = "@use 'option';\n@use 'slice';\n&slice_len 0;"
        const { source, visited } = resolveUses(src, P('main.si'), { stdlib })

        expect(visited).toEqual(['std:option.si', 'std:slice.si', P('main.si')])
        expect(source.indexOf('option module')).toBeLessThan(source.indexOf('slice module'))
    })

    test('unknown bare module throws a clear error', () => {
        const stdlib = inMemoryStdlib({ 'io.si': '# io' })
        let err: Error | undefined
        try { resolveUses("@use 'nope';\n@fn main := 0;", P('main.si'), { stdlib }) }
        catch (e) { err = e as Error }
        expect(err?.message).toContain("unknown stdlib module 'nope'")
    })

    test('wasm-gc target prefers the gc/ shadow module', () => {
        const stdlib = inMemoryStdlib({
            'rc.si': '# bump-allocator rc',
            'gc/rc.si': '# gc shadow rc',
        })
        const gc = resolveUses("@use 'rc';\n@fn main := 0;", P('main.si'), { stdlib, target: 'wasm-gc' })
        expect(gc.visited).toContain('std:gc/rc.si')
        expect(gc.source).toContain('gc shadow rc')

        // Default target gets the non-gc module.
        const host = resolveUses("@use 'rc';\n@fn main := 0;", P('main.si'), { stdlib })
        expect(host.visited).toContain('std:rc.si')
        expect(host.source).toContain('bump-allocator rc')
    })

    test('bare-name and path-form @use coexist', () => {
        const stdlib = inMemoryStdlib({ 'io.si': '# io module' })
        const lookup: Record<string, string> = { [P('helper.si')]: '# local helper' }
        const { source, visited } = resolveUses(
            "@use 'io';\n@use 'helper.si';\n@fn main := 0;",
            P('main.si'),
            {
                stdlib,
                readFile: (p) => lookup[p],
                fileExists: (p) => p in lookup,
            },
        )
        expect(visited).toEqual(['std:io.si', P('helper.si'), P('main.si')])
        expect(source).toContain('io module')
        expect(source).toContain('local helper')
    })

    test('a commented-out bare @use is not followed', () => {
        const stdlib = inMemoryStdlib({ 'io.si': '# io module' })
        const { source, visited } = resolveUses("# @use 'io';\n@fn main := 0;", P('main.si'), { stdlib })
        expect(visited).toEqual([P('main.si')])
        expect(source).not.toContain('io module')
    })

    test('default hook resolves the real bundled io.si (no injection)', () => {
        // No `stdlib` override → uses the swappable stdlibSource module.
        const { source, visited } = resolveUses("@use 'io';\n&print 'x';", P('main.si'))
        expect(visited).toContain('std:io.si')
        expect(source).toContain('fd_write')   // io.si writes via wasi fd_write
        expect(source).toContain('@fn print')
    })
})
