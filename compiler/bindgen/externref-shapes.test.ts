// SPDX-License-Identifier: MIT
/**
 * ADR 0018 — the externref binding SHAPES that the constructed Web interface
 * modules (url/headers/text_encoder/…) are built from: getter, setter, instance
 * method, constructor, static, and cross-handle threading.  This guards the
 * foundation those generated modules rest on — that the compiler needs ZERO
 * changes for any of them: a constructed-interface binding is just `@extern`
 * lines over JSValue (the object handle) + JSString (a string), both of which
 * lower to nullable externref (lower.ts isExternRefKind ~L560, lowerModuleCall
 * ~L1489-1580).  The host is a plain JS object — no js-string builtins required.
 * Complements jsvalue.test.ts (WAT-level) by proving each shape RUNS correctly
 * under Bun against a real JS class instance.
 *
 * The module registry is built in-memory so the shared modules/ dir is untouched.
 */

import { test, expect, describe } from 'bun:test'
import { compile } from '../src/caas/index'
import { loadModules, parseModuleDecls } from '../src/modules/loader'

// Every shape we need, as plain @extern lines under module `probe`.
// Silicon strings are single-quoted; @fn params comma-separated; void omits -> Ret.
const PROBE_SI = `
\\\\ @extern get_name (JSValue) -> JSString;
\\\\ @extern set_name (JSValue, JSString);
\\\\ @extern greet (JSValue, JSString, JSString) -> JSString;
\\\\ @extern make (JSString) -> JSValue;
\\\\ @extern read_name (JSValue) -> JSString;
\\\\ @extern is_valid (JSString) -> Bool;
\\\\ @extern clone (JSValue) -> JSValue;
`

function makeMods() {
    const mods = loadModules(process.cwd())
    mods.set('probe', { name: 'probe', kind: 'env', functions: parseModuleDecls(PROBE_SI) } as any)
    return mods
}

function compileBin(src: string): Uint8Array {
    const r: any = compile(src, { file: 'probe.si', moduleRegistry: makeMods(), target: 'host', platform: 'bun', emitBinary: true } as any)
    if ((r.diagnostics ?? []).length) {
        throw new Error('COMPILE DIAGNOSTICS: ' + JSON.stringify(r.diagnostics))
    }
    if (!r.binary) throw new Error('no binary emitted')
    return r.binary
}

// A real JS class instance is the "object" the JSValue handle points to.
class Thing {
    name: string
    constructor(name: string) { this.name = name }
}

const envStub = { print: () => {}, read: () => 0 }

async function instantiate(bin: Uint8Array, probe: Record<string, any>) {
    return new WebAssembly.Instance(await WebAssembly.compile(bin), { env: envStub, probe })
}

describe('PROBE — constructed Web interface binding shapes (externref)', () => {
    // 1. Getter: (JSValue) -> JSString
    test('1. getter (JSValue) -> JSString', async () => {
        const bin = compileBin(`\\\\ run (JSValue) -> JSString
@fn run obj := { probe::get_name(obj) };
@export run;`)
        const inst = await instantiate(bin, { get_name: (h: Thing) => h.name })
        const out = (inst.exports as any).run(new Thing('Ada'))
        expect(out).toBe('Ada')
    })

    // 2. Setter: (JSValue, JSString) with no result; returns the mutated handle so we can read it.
    test('2. setter (JSValue, JSString) -> void', async () => {
        const bin = compileBin(`\\\\ run (JSValue, JSString) -> JSValue
@fn run obj, v := { probe::set_name(obj, v); obj };
@export run;`)
        const inst = await instantiate(bin, { set_name: (h: Thing, v: string) => { h.name = v } })
        const t = new Thing('old')
        const ret = (inst.exports as any).run(t, 'new')
        expect(t.name).toBe('new')   // setter mutated the JS object
        expect(ret).toBe(t)          // same handle round-tripped out
    })

    // 3. Instance method, 3 externref params: (JSValue, JSString, JSString) -> JSString
    test('3. instance method (JSValue, JSString, JSString) -> JSString', async () => {
        const bin = compileBin(`\\\\ run (JSValue, JSString, JSString) -> JSString
@fn run obj, greeting, punct := { probe::greet(obj, greeting, punct) };
@export run;`)
        const inst = await instantiate(bin, {
            greet: (h: Thing, g: string, p: string) => `${g}, ${h.name}${p}`,
        })
        const out = (inst.exports as any).run(new Thing('World'), 'Hello', '!')
        expect(out).toBe('Hello, World!')
    })

    // 4. Constructor-like: (JSString) -> JSValue
    test('4. constructor (JSString) -> JSValue', async () => {
        const bin = compileBin(`\\\\ run (JSString) -> JSValue
@fn run s := { probe::make(s) };
@export run;`)
        const inst = await instantiate(bin, { make: (s: string) => new Thing(s) })
        const out = (inst.exports as any).run('Grace')
        expect(out).toBeInstanceOf(Thing)
        expect(out.name).toBe('Grace')
    })

    // 5. Handle threading: B(A(s)) — A (JSString)->JSValue, B (JSValue)->JSString, no host inspection of guest.
    test('5. handle threading B(A(s)) — construct then read back', async () => {
        const bin = compileBin(`\\\\ run (JSString) -> JSString
@fn run s := { probe::read_name(probe::make(s)) };
@export run;`)
        const inst = await instantiate(bin, {
            make: (s: string) => new Thing(s),     // JSString -> JSValue handle
            read_name: (h: Thing) => h.name,        // JSValue handle -> JSString
        })
        const out = (inst.exports as any).run('Linus')
        expect(out).toBe('Linus')   // handle never touched linear memory; crossed as externref
    })

    // 6. Static-like, no receiver: (JSString) -> Bool
    test('6. static (JSString) -> Bool', async () => {
        const bin = compileBin(`\\\\ run (JSString) -> Bool
@fn run s := { probe::is_valid(s) };
@export run;`)
        const inst = await instantiate(bin, { is_valid: (s: string) => s.length > 0 })
        expect((inst.exports as any).run('x')).toBe(1)    // true
        expect((inst.exports as any).run('')).toBe(0)     // false
    })

    // 7. Mixed: (JSValue) -> JSValue — handle in, handle out.
    test('7. handle in / handle out (JSValue) -> JSValue', async () => {
        const bin = compileBin(`\\\\ run (JSValue) -> JSValue
@fn run obj := { probe::clone(obj) };
@export run;`)
        const inst = await instantiate(bin, { clone: (h: Thing) => new Thing(h.name + '-copy') })
        const src = new Thing('orig')
        const out = (inst.exports as any).run(src)
        expect(out).toBeInstanceOf(Thing)
        expect(out).not.toBe(src)
        expect(out.name).toBe('orig-copy')
    })
})
