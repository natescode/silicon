// SPDX-License-Identifier: MIT
/**
 * ADR-0024 component assembler — static merge, name-prefixing, visibility, and
 * the module-edge diagnostics (E-DUP-MOD / E-DUP-DEF / E-MOD-TOPSTMT /
 * E-MOD-CYCLE / E-PRIV / W-USE-REDUNDANT). Driven through a virtual filesystem.
 */

import { describe, test, expect } from 'bun:test'
import { assembleComponent, type AssembleOptions } from './component'

/** Build a virtual FS from a `{ '/abs/path.si': 'source' }` map. */
function vfs(files: Record<string, string>): AssembleOptions {
    const norm = (p: string) => p.replace(/\/+$/, '')
    const paths = Object.keys(files)
    return {
        readFile: (p) => files[norm(p)],
        fileExists: (p) => norm(p) in files,
        listDir: (dir) => {
            const d = norm(dir)
            const isFileDir = paths.some(p => p === d)
            if (isFileDir) return undefined
            const names = new Set<string>()
            let isDir = false
            for (const p of paths) {
                if (p === d) continue
                if (p.startsWith(d + '/')) {
                    isDir = true
                    const rest = p.slice(d.length + 1)
                    const seg = rest.split('/')[0]
                    names.add(seg)
                }
            }
            if (!isDir) return undefined
            return [...names].map(name => ({
                name,
                isDir: !paths.includes(d + '/' + name),
            }))
        },
        // Avoid touching the real stdlib bundle in these unit tests.
        stdlib: { read: () => undefined, has: () => false },
    }
}

describe('ADR-0024 assembler — static merge + name-prefixing', () => {
    test('sub-module defs and cross-module calls are prefixed to M__name', () => {
        const opts = vfs({
            '/p/src/main.si': `@fn main := { strings::trim('  hi  ') };`,
            '/p/src/strings/trim.si': `\\\\ @pub trim (Str) -> Str\n@fn trim s := { scan_ws(s) };\n\\\\ scan_ws (Str) -> Str\n@fn scan_ws s := { s };`,
        })
        const r = assembleComponent('/p/src/main.si', opts)
        expect(r.diagnostics.filter(d => d.severity === 'error')).toEqual([])
        expect(r.moduleNames).toEqual(['strings'])
        expect(r.hasMain).toBe(true)
        // sub def renamed (both sig + def line), intra-module call renamed
        expect(r.source).toContain('@fn strings__trim')
        expect(r.source).toContain('strings__scan_ws(s)')
        expect(r.source).toContain('@fn strings__scan_ws')
        // root cross-module call renamed
        expect(r.source).toContain('strings__trim(')
        // no leftover :: for the source module
        expect(r.source).not.toContain('strings::')
    })

    test('a private member referenced cross-module is E-PRIV', () => {
        const opts = vfs({
            '/p/src/main.si': `@fn main := { strings::scan_ws('x') };`,
            '/p/src/strings/trim.si': `\\\\ @pub trim (Str) -> Str\n@fn trim s := { scan_ws(s) };\n\\\\ scan_ws (Str) -> Str\n@fn scan_ws s := { s };`,
        })
        const r = assembleComponent('/p/src/main.si', opts)
        const priv = r.diagnostics.filter(d => d.code === 'E-PRIV')
        expect(priv).toHaveLength(1)
        expect(priv[0].message).toContain('strings::scan_ws')
    })

    test('intra-module access to a private sibling is allowed (no E-PRIV)', () => {
        const opts = vfs({
            '/p/src/main.si': `@fn main := { strings::shout('x') };`,
            '/p/src/strings/a.si': `\\\\ @pub shout (Str) -> Str\n@fn shout s := { scan_ws(s) };`,
            '/p/src/strings/b.si': `\\\\ scan_ws (Str) -> Str\n@fn scan_ws s := { s };`,
        })
        const r = assembleComponent('/p/src/main.si', opts)
        expect(r.diagnostics.filter(d => d.code === 'E-PRIV')).toEqual([])
        // files in one module share scope: shout (file a) calls scan_ws (file b)
        expect(r.source).toContain('strings__scan_ws')
    })
})

describe('ADR-0024 assembler — scope-aware prefixing', () => {
    test('a param shadowing a top-level def name is NOT prefixed', () => {
        const opts = vfs({
            '/p/src/main.si': `@fn main := { util::run(1) };`,
            // module `util` has top-level `helper` AND a fn whose param is `helper`
            '/p/src/util/u.si':
                `\\\\ @pub run (Int) -> Int\n@fn run helper := { helper };\n` +
                `\\\\ helper (Int) -> Int\n@fn helper x := { x };`,
        })
        const r = assembleComponent('/p/src/main.si', opts)
        expect(r.diagnostics.filter(d => d.severity === 'error')).toEqual([])
        // The param read `{ helper }` must stay bare (it's the param), not util__helper.
        expect(r.source).toContain('@fn util__run helper := { helper }')
        // The actual top-level helper IS prefixed at its def site.
        expect(r.source).toContain('@fn util__helper')
    })

    test('a match-bound variable shadowing a def name is NOT prefixed', () => {
        const opts = vfs({
            '/p/src/main.si': `@fn main := { m::pick(1) };`,
            '/p/src/m/m.si':
                `\\\\ @pub pick (Int) -> Int\n@fn pick opt := @match(opt, $Some v, { v }, $None, { 0 });\n` +
                `\\\\ v (Int) -> Int\n@fn v x := { x };`,
        })
        const r = assembleComponent('/p/src/main.si', opts)
        // `{ v }` arm reads the match binding, not the top-level fn `v`.
        expect(r.source).toContain('$Some v, { v }')
        expect(r.source).toContain('@fn m__v')
    })
})

describe('ADR-0024 assembler — module-edge diagnostics', () => {
    test('E-DUP-MOD on two directories with the same base name', () => {
        const opts = vfs({
            '/p/src/main.si': `@fn main := { 0 };`,
            '/p/src/a/x.si': `\\\\ @pub f (Int) -> Int\n@fn f x := { x };`,
            '/p/src/nested/a/y.si': `\\\\ @pub g (Int) -> Int\n@fn g x := { x };`,
        })
        const r = assembleComponent('/p/src/main.si', opts)
        expect(r.diagnostics.some(d => d.code === 'E-DUP-MOD')).toBe(true)
    })

    test('E-DUP-DEF on two files defining the same top-level name', () => {
        const opts = vfs({
            '/p/src/main.si': `@fn main := { 0 };`,
            '/p/src/m/a.si': `\\\\ @pub f (Int) -> Int\n@fn f x := { x };`,
            '/p/src/m/b.si': `\\\\ @pub f (Int) -> Int\n@fn f y := { y };`,
        })
        const r = assembleComponent('/p/src/main.si', opts)
        const dup = r.diagnostics.find(d => d.code === 'E-DUP-DEF')
        expect(dup).toBeTruthy()
        // Names the actual source files, not just the module directory.
        expect(dup!.file).toBe('/p/src/m/b.si')
        expect(dup!.message).toContain('/p/src/m/a.si')
        expect(dup!.message).toContain('/p/src/m/b.si')
        expect(dup!.file).not.toBe('/p/src/m')   // was previously the module dir
    })

    test('E-MOD-TOPSTMT on a top-level statement in a sub-module', () => {
        const opts = vfs({
            '/p/src/main.si': `@fn main := { 0 };`,
            '/p/src/m/a.si': `\\\\ @pub f (Int) -> Int\n@fn f x := { x };\nf(1);`,
        })
        const r = assembleComponent('/p/src/main.si', opts)
        expect(r.diagnostics.some(d => d.code === 'E-MOD-TOPSTMT')).toBe(true)
    })

    test('top-level statement in the ROOT module is allowed', () => {
        const opts = vfs({
            '/p/src/main.si': `@fn main := { 0 };\nmain();`,
        })
        const r = assembleComponent('/p/src/main.si', opts)
        expect(r.diagnostics.some(d => d.code === 'E-MOD-TOPSTMT')).toBe(false)
    })

    test('E-MOD-CYCLE on mutually-referencing modules', () => {
        const opts = vfs({
            '/p/src/main.si': `@fn main := { a::f(1) };`,
            '/p/src/a/a.si': `\\\\ @pub f (Int) -> Int\n@fn f x := { b::g(x) };`,
            '/p/src/b/b.si': `\\\\ @pub g (Int) -> Int\n@fn g x := { a::f(x) };`,
        })
        const r = assembleComponent('/p/src/main.si', opts)
        const cyc = r.diagnostics.filter(d => d.code === 'E-MOD-CYCLE')
        expect(cyc.length).toBeGreaterThanOrEqual(1)
        expect(cyc[0].message).toContain('->')
    })

    test('no cycle for a DAG (a -> b, both fine)', () => {
        const opts = vfs({
            '/p/src/main.si': `@fn main := { a::f(1) };`,
            '/p/src/a/a.si': `\\\\ @pub f (Int) -> Int\n@fn f x := { b::g(x) };`,
            '/p/src/b/b.si': `\\\\ @pub g (Int) -> Int\n@fn g x := { x };`,
        })
        const r = assembleComponent('/p/src/main.si', opts)
        expect(r.diagnostics.some(d => d.code === 'E-MOD-CYCLE')).toBe(false)
    })
})

describe('ADR-0024 assembler — @use scoping', () => {
    test('intra-module path @use is redundant (W-USE-REDUNDANT) and stripped', () => {
        const opts = vfs({
            '/p/src/main.si': `@use 'greeting.si';\n@fn main := { greet() };`,
            '/p/src/greeting.si': `\\\\ greet () -> Int\n@fn greet := { 42 };`,
        })
        const r = assembleComponent('/p/src/main.si', opts)
        expect(r.diagnostics.some(d => d.code === 'W-USE-REDUNDANT')).toBe(true)
        // The directive is stripped from the merged source.
        expect(r.source).not.toContain("@use 'greeting.si'")
        // Both root-module siblings are auto-included, so greet is present.
        expect(r.source).toContain('@fn greet')
    })

    test('library component without main reports hasMain=false', () => {
        const opts = vfs({
            '/p/src/lib.si': `\\\\ @export add (Int, Int) -> Int\n@fn add a, b := { a + b };`,
        })
        const r = assembleComponent('/p/src/lib.si', opts)
        expect(r.hasMain).toBe(false)
        expect(r.rootExports).toEqual(['add'])
    })
})

describe('ADR-0024 assembler — cross-component dependencies', () => {
    const depFiles = {
        '/app/src/main.si': `\\\\ @use mathlib as ml;\n\\\\ @export run () -> Int\n@fn run := { ml::clamp(0, 10, 42) };`,
        '/mathlib/src/lib.si':
            `\\\\ @export @pub clamp (Int, Int, Int) -> Int\n@fn clamp lo, hi, x := { x };\n` +
            `\\\\ secret (Int) -> Int\n@fn secret x := { x };`,
    }
    const depOpts = (extra?: Record<string, string>) => ({
        ...vfs({ ...depFiles, ...extra }),
        dependencies: [{ name: 'mathlib', entryFile: '/mathlib/src/lib.si' }],
    })

    test('an aliased dependency call merges + prefixes under the dep name', () => {
        const r = assembleComponent('/app/src/main.si', depOpts())
        expect(r.diagnostics.filter(d => d.severity === 'error')).toEqual([])
        expect(r.source).toContain('mathlib__clamp')      // dep member, prefixed + merged
        expect(r.source).not.toContain('ml::')             // alias resolved away
        expect(r.source).not.toContain('@export clamp')    // dep export stripped (not in consumer's world)
    })

    test('calling a non-exported dependency member is E-PRIV', () => {
        const opts = depOpts({
            '/app/src/main.si': `\\\\ @use mathlib as ml;\n\\\\ @export run () -> Int\n@fn run := { ml::secret(1) };`,
        })
        const r = assembleComponent('/app/src/main.si', opts)
        expect(r.diagnostics.some(d => d.code === 'E-PRIV')).toBe(true)
    })

    test('an unresolved dependency is E-DEP-UNRESOLVED', () => {
        const opts = vfs({
            '/app/src/main.si': `\\\\ @use missing as mz;\n@fn main := { mz::f(1) };`,
        })
        const r = assembleComponent('/app/src/main.si', opts)
        expect(r.diagnostics.some(d => d.code === 'E-DEP-UNRESOLVED')).toBe(true)
    })

    test('a dependency cycle is E-DEP-CYCLE', () => {
        const opts = {
            ...vfs({
                '/app/src/main.si': `\\\\ @use a;\n\\\\ @export run () -> Int\n@fn run := { a::f(1) };`,
                '/a/src/lib.si': `\\\\ @use b;\n\\\\ @export @pub f (Int) -> Int\n@fn f x := { b::g(x) };`,
                '/b/src/lib.si': `\\\\ @use a;\n\\\\ @export @pub g (Int) -> Int\n@fn g x := { a::f(x) };`,
            }),
            dependencies: [
                { name: 'a', entryFile: '/a/src/lib.si' },
                { name: 'b', entryFile: '/b/src/lib.si' },
            ],
        }
        const r = assembleComponent('/app/src/main.si', opts)
        expect(r.diagnostics.some(d => d.code === 'E-DEP-CYCLE')).toBe(true)
    })
})
