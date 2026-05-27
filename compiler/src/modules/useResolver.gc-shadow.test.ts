/**
 * Phase 9d-6 — `@use` resolver picks `…/stdlib/gc/X.si` over
 * `…/stdlib/X.si` when `options.target === 'wasm-gc'`.
 *
 * Uses an in-memory filesystem so the suite has no disk dependency
 * and can exercise the fallthrough behavior cleanly.
 */

import { test, expect, describe } from 'bun:test'
import { resolve } from 'path'
import { resolveUses } from './useResolver'

function P(p: string): string {
    return resolve('/', p)
}

function inMemoryFs(files: Record<string, string>) {
    const lookup: Record<string, string> = {}
    for (const [k, v] of Object.entries(files)) lookup[P(k)] = v
    return {
        files: lookup,
        readFile: (p: string) => lookup[p],
        fileExists: (p: string) => p in lookup,
    }
}

describe('useResolver: wasm-gc stdlib shadow', () => {

    test('target=wasm-gc picks gc/X.si over X.si when both exist', () => {
        const fs = inMemoryFs({
            'project/src/stdlib/rc.si':    '@fn rc_new value:Int := { value + 1 };',   // mvp (sentinel value)
            'project/src/stdlib/gc/rc.si': '@fn rc_new value:Int := value;',            // gc (identity sentinel)
            'project/main.si':             "@use 'src/stdlib/rc.si';\n@fn use_it:Int := &rc_new 42;",
        })
        const { source, visited } = resolveUses(
            fs.files[P('project/main.si')]!,
            P('project/main.si'),
            { ...fs, target: 'wasm-gc' },
        )
        // gc variant resolved.
        expect(visited).toContain(P('project/src/stdlib/gc/rc.si'))
        expect(visited).not.toContain(P('project/src/stdlib/rc.si'))
        // The gc body (`value;`) appears in the merged source; the mvp
        // body (`value + 1`) does not.
        expect(source).toContain('rc_new value:Int := value;')
        expect(source).not.toContain('value + 1')
    })

    test('target=wasm-gc falls through to X.si when no gc shadow exists', () => {
        const fs = inMemoryFs({
            // option.si has no gc shadow yet (9d-7 hasn't routed sums).
            'project/src/stdlib/option.si': '@fn opt_marker:Int := 7;',
            'project/main.si':              "@use 'src/stdlib/option.si';\n",
        })
        const { source, visited } = resolveUses(
            fs.files[P('project/main.si')]!,
            P('project/main.si'),
            { ...fs, target: 'wasm-gc' },
        )
        expect(visited).toContain(P('project/src/stdlib/option.si'))
        expect(source).toContain('opt_marker:Int := 7')
    })

    test('target=host (default) always uses X.si even when gc shadow exists', () => {
        const fs = inMemoryFs({
            'project/src/stdlib/rc.si':    '@fn rc_new value:Int := { value + 1 };',
            'project/src/stdlib/gc/rc.si': '@fn rc_new value:Int := value;',
            'project/main.si':             "@use 'src/stdlib/rc.si';\n",
        })
        const { source, visited } = resolveUses(
            fs.files[P('project/main.si')]!,
            P('project/main.si'),
            { ...fs, target: 'host' },
        )
        expect(visited).toContain(P('project/src/stdlib/rc.si'))
        expect(visited).not.toContain(P('project/src/stdlib/gc/rc.si'))
        expect(source).toContain('value + 1')
    })

    test('target undefined behaves like host (no shadow)', () => {
        const fs = inMemoryFs({
            'project/src/stdlib/rc.si':    '@fn rc_new value:Int := { value + 1 };',
            'project/src/stdlib/gc/rc.si': '@fn rc_new value:Int := value;',
            'project/main.si':             "@use 'src/stdlib/rc.si';\n",
        })
        const { source, visited } = resolveUses(
            fs.files[P('project/main.si')]!,
            P('project/main.si'),
            fs,
        )
        expect(visited).toContain(P('project/src/stdlib/rc.si'))
        expect(visited).not.toContain(P('project/src/stdlib/gc/rc.si'))
    })

    test('non-stdlib paths are never shadowed (helper.si stays as helper.si)', () => {
        const fs = inMemoryFs({
            // A user-side helper that happens to live somewhere named
            // "stdlib" must NOT be redirected if it doesn't sit directly
            // under a `stdlib/` directory.
            'project/lib/helper.si':       '@fn helper:Int := 0;',
            // Even if there's a `lib/gc/helper.si` it shouldn't be used.
            'project/lib/gc/helper.si':    '@fn helper:Int := 999;',
            'project/main.si':             "@use 'lib/helper.si';\n",
        })
        const { source, visited } = resolveUses(
            fs.files[P('project/main.si')]!,
            P('project/main.si'),
            { ...fs, target: 'wasm-gc' },
        )
        // The shadow rewriter only fires for `…/stdlib/X.si` paths.
        // `lib/helper.si` doesn't sit under a directory named `stdlib`,
        // so it passes through unchanged.
        expect(visited).toContain(P('project/lib/helper.si'))
        expect(visited).not.toContain(P('project/lib/gc/helper.si'))
        expect(source).toContain('helper:Int := 0')
    })

    test('nested stdlib paths (already under gc/) are not double-rewritten', () => {
        // If a gc-side stdlib file itself @use's another gc stdlib file,
        // the resolver shouldn't try to redirect …/stdlib/gc/X.si to
        // …/stdlib/gc/gc/X.si.
        const fs = inMemoryFs({
            'project/src/stdlib/gc/string.si': "@fn gc_string_marker:Int := 1;",
            // No `gc/gc/string.si` exists — if the resolver tries to
            // redirect it, the fileExists check returns false, and the
            // fallthrough should pick the original `gc/string.si`.
            'project/main.si':                 "@use 'src/stdlib/gc/string.si';\n",
        })
        const { source, visited } = resolveUses(
            fs.files[P('project/main.si')]!,
            P('project/main.si'),
            { ...fs, target: 'wasm-gc' },
        )
        expect(visited).toContain(P('project/src/stdlib/gc/string.si'))
        expect(source).toContain('gc_string_marker:Int := 1')
    })
})
