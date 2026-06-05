// SPDX-License-Identifier: MIT
/**
 * Unit tests for the `@use 'path.si';` resolver — Phase −1.C of bootstrap plan.
 *
 * Uses an in-memory filesystem (readFile / fileExists overrides) so the tests
 * have no disk dependency and can exercise cycles, missing files, comment
 * shadowing, and nested includes cleanly.
 *
 * Paths are built with `path.resolve` so the suite works on both Windows
 * (drive-letter normalisation) and POSIX hosts.
 */

import { test, expect, describe } from 'bun:test'
import { resolve, sep } from 'path'
import { resolveUses } from './useResolver'

/** Resolve a POSIX-ish path-fragment to whatever the running platform calls home. */
function P(p: string): string {
    return resolve('/', p)
}

/** Build options that pretend `fs` is the supplied path -> source map. */
function inMemoryFs(files: Record<string, string>) {
    const lookup: Record<string, string> = {}
    for (const [k, v] of Object.entries(files)) lookup[P(k)] = v
    return {
        files: lookup,
        readFile: (p: string) => lookup[p],
        fileExists: (p: string) => p in lookup,
    }
}

describe('resolveUses', () => {
    test('source without @use is returned unchanged (modulo region markers)', () => {
        const fs = inMemoryFs({ 'main.si': '@global x := 1;' })
        const { source, visited } = resolveUses(fs.files[P('main.si')]!, P('main.si'), fs)
        expect(source).toContain('@global x := 1;')
        expect(visited).toEqual([P('main.si')])
    })

    test('single @use is resolved and prepended', () => {
        const fs = inMemoryFs({
            'main.si': "@use 'helper.si';\n@global m := &help 1;",
            'helper.si': '\\\\ help (Int)\n@fn help v := { v + 1 };',
        })
        const { source, visited } = resolveUses(fs.files[P('main.si')]!, P('main.si'), fs)
        expect(visited).toEqual([P('helper.si'), P('main.si')])
        // helper.si content appears before main.si content.
        const helperIdx = source.indexOf('@fn help v')
        const mainIdx = source.indexOf('m := &help')
        expect(helperIdx).toBeGreaterThan(-1)
        expect(mainIdx).toBeGreaterThan(helperIdx)
        // @use directive itself stripped from the merged output.
        expect(source).not.toContain("@use 'helper.si';")
    })

    test('nested @use chains are visited in dependency order', () => {
        const fs = inMemoryFs({
            'main.si': "@use 'mid.si';\n@global m := &mid_fn;",
            'mid.si':  "@use 'leaf.si';\n@fn mid_fn := { &leaf_fn };",
            'leaf.si': '@fn leaf_fn  := { 1 };',
        })
        const { visited } = resolveUses(fs.files[P('main.si')]!, P('main.si'), fs)
        expect(visited).toEqual([P('leaf.si'), P('mid.si'), P('main.si')])
    })

    test('duplicate @use of the same file emits the file only once', () => {
        const fs = inMemoryFs({
            'main.si': "@use 'a.si';\n@use 'a.si';\n@global m := 0;",
            'a.si':    '@fn a  := { 1 };',
        })
        const { source, visited } = resolveUses(fs.files[P('main.si')]!, P('main.si'), fs)
        expect(visited).toEqual([P('a.si'), P('main.si')])
        const matches = source.match(/@fn a\b/g) ?? []
        expect(matches.length).toBe(1)
    })

    test('cycle: A uses B uses A throws with a useful error', () => {
        const fs = inMemoryFs({
            'a.si': "@use 'b.si';\n@fn from_a := { 1 };",
            'b.si': "@use 'a.si';\n@fn from_b := { 2 };",
        })
        let err = ''
        try { resolveUses(fs.files[P('a.si')]!, P('a.si'), fs) }
        catch (e) { err = String(e) }
        expect(err).toMatch(/@use cycle/)
        expect(err).toMatch(/a\.si/)
        expect(err).toMatch(/b\.si/)
    })

    test('missing file throws with the resolved path in the error', () => {
        const fs = inMemoryFs({ 'main.si': "@use 'nope.si';\n@global x := 0;" })
        let err = ''
        try { resolveUses(fs.files[P('main.si')]!, P('main.si'), fs) }
        catch (e) { err = String(e) }
        expect(err).toMatch(/cannot resolve/)
        expect(err).toMatch(/nope\.si/)
    })

    test('@use inside a # comment is NOT followed', () => {
        const fs = inMemoryFs({
            'main.si': "# @use 'never.si';\n@global x := 1;",
        })
        const { source, visited } = resolveUses(fs.files[P('main.si')]!, P('main.si'), fs)
        expect(visited).toEqual([P('main.si')])
        expect(source).toContain("# @use 'never.si';")
    })

    test('relative paths resolve from the including file, not the entry', () => {
        const fs = inMemoryFs({
            'proj/main.si':       "@use 'lib/a.si';\n@global m := 0;",
            'proj/lib/a.si':      "@use './b.si';\n@fn a := { 1 };",
            'proj/lib/b.si':      '@fn b  := { 2 };',
        })
        const { visited } = resolveUses(fs.files[P('proj/main.si')]!, P('proj/main.si'), fs)
        expect(visited).toEqual([
            P('proj/lib/b.si'),
            P('proj/lib/a.si'),
            P('proj/main.si'),
        ])
    })
})
