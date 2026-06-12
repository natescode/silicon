// SPDX-License-Identifier: MIT
/**
 * ADR 0017 — bindgen `check-shims`: the lockstep guarantee.
 *
 * Proves the generator is the single source of truth for the Web Math/clock
 * surface and that the three hand-maintained-until-now sites agree:
 *   1. every marked region reproduces the generator output byte-for-byte;
 *   2. the (module, field, arity) key set is identical across the `.si` decls
 *      and both JS shims;
 *   3. the content hash matches bindgen.lock.json (spec-drift tripwire);
 *   4. a generated `@extern` actually compiles + runs (defeats the
 *      loader.ts silent-skip trap — a malformed decl would parse to an empty
 *      module and only surface far downstream).
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { createHash } from 'crypto'
import { WEB_MATH_CLOCK, WEB_MODULE } from './src/spec'
import { generate, siToWasm } from './src/generate'
import { compile } from '../src/caas/index'
import { loadModules } from '../src/modules/loader'

const START = 'bindgen:web math+clock'
const END = '/bindgen:web math+clock'

/** Extract the bytes between the bindgen markers in a file (cwd = compiler/). */
function region(path: string): string {
    const lines = readFileSync(path, 'utf8').split('\n')
    const s = lines.findIndex(l => l.includes(START) && !l.includes(END))
    const e = lines.findIndex(l => l.includes(END))
    if (s === -1 || e === -1 || e <= s) throw new Error(`${path}: bindgen markers not found`)
    return lines.slice(s + 1, e).join('\n')
}

const g = generate(WEB_MODULE, WEB_MATH_CLOCK)

describe('bindgen — Web Math/clock surface (ADR 0017 first milestone)', () => {
    test('every binding is Tier-0 (correct-by-construction)', () => {
        expect(g.ir.decls.length).toBe(17)
        expect(g.ir.decls.every(d => d.tier === 0)).toBe(true)
    })

    test('the .si @extern block matches the generator byte-for-byte', () => {
        expect(region('src/strata/modules/web.si')).toBe(g.si)
    })

    test('the Bun host shim matches the generator byte-for-byte', () => {
        expect(region('../cli/src/host/js-host.ts')).toBe(g.bunShim)
    })

    test('the browser host shim matches the generator byte-for-byte', () => {
        expect(region('../playground/playground/web-env.js')).toBe(g.webShim)
    })

    test('the (module, field, arity) key set is identical across all three sites', () => {
        // Derive the key set from each emitted artifact independently and assert
        // they agree — the ADR lockstep invariant.
        const fromSi = [...g.si.matchAll(/@extern (\w+) \(([^)]*)\)/g)]
            .map(m => `${WEB_MODULE}::${m[1]}/${m[2].trim() === '' ? 0 : m[2].split(',').length}`)
        const fromBun = [...g.bunShim.matchAll(/^\s+(\w+):/gm)].map(m => m[1])
        const fromWeb = [...g.webShim.matchAll(/^\s+(\w+):\s+function \(([^)]*)\)/gm)]
            .map(m => `${WEB_MODULE}::${m[1]}/${m[2].trim() === '' ? 0 : m[2].split(',').length}`)
        expect(fromSi).toEqual([...g.keys])
        expect(fromWeb).toEqual([...g.keys])
        // Bun shim is terse (no arglist) — assert the field-name set agrees.
        expect(fromBun).toEqual(g.ir.decls.map(d => d.name))
    })

    test('the content hash matches bindgen.lock.json', () => {
        const lock = JSON.parse(readFileSync('bindgen/bindgen.lock.json', 'utf8'))
        const blob = g.si + '\x00' + g.bunShim + '\x00' + g.webShim
        const hash = createHash('sha256').update(blob).digest('hex')
        const surface = lock.surfaces.find((s: any) => s.module === 'web' && s.group === 'math+clock')
        expect(surface).toBeTruthy()
        expect(surface.sha256).toBe(hash)
        expect(surface.bindings).toBe(g.ir.decls.length)
    })

    test('the type map is the authoritative boundary map (Float→f32, no narrowing surprises)', () => {
        expect(siToWasm('Float')).toBe('f32')
        expect(siToWasm('Int')).toBe('i32')
        expect(siToWasm('Int64')).toBe('i64')
    })

    test('a generated @extern compiles + runs (round-trip; defeats the loader silent-skip)', async () => {
        const mods = loadModules(process.cwd())
        const r: any = compile(
            `\\\\ run () -> Float
@fn run := { web::math_sqrt(16.0) };
@export run;`,
            { file: 'm.si', moduleRegistry: mods, target: 'host', platform: 'bun', emitBinary: true } as any,
        )
        expect(r.diagnostics?.length ?? 0).toBe(0)
        // The decl really lowered to an `(import "web" "math_sqrt" …)`.
        expect(r.wat).toContain('(import "web" "math_sqrt"')
        // Instantiate with an import object built straight from the spec's impls
        // (proves the shim recipe is callable at the generated arity).
        const web: Record<string, any> = {}
        for (const d of g.ir.decls) {
            web[d.name] = d.impl.kind === 'mathRef' ? (Math as any)[d.impl.method] : () => 0
        }
        const imports = { env: { print: () => {}, read: () => 0 }, web }
        const instance = new WebAssembly.Instance(await WebAssembly.compile(r.binary), imports)
        expect((instance.exports as any).run()).toBeCloseTo(4.0)
    })
})
