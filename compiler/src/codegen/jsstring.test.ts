// SPDX-License-Identifier: MIT
/**
 * W2/W3 — JSString end-to-end: a Silicon program using the `wasm:js-string`
 * builtins compiles to a module that runs natively under Bun via
 * `{ builtins: ['js-string'] }`.
 */
import { describe, test, expect } from 'bun:test'
import { compile } from '../caas/index'
import { loadModules } from '../modules/loader'

const ROOT = new URL('../../..', import.meta.url).pathname   // repo root (has src/strata/modules)

function buildBun(src: string): Uint8Array {
    const mods = loadModules(ROOT)
    const r = compile(src, { file: 'm.si', moduleRegistry: mods, target: 'host', platform: 'bun', emitBinary: true } as any)
    if (r.diagnostics.length) throw new Error('compile diagnostics: ' + r.diagnostics.map((d: any) => `${d.code}:${d.message}`).join('; '))
    return r.binary!
}

async function instantiate(bin: Uint8Array, log: (s: string) => void) {
    const mod = await WebAssembly.compile(bin, { builtins: ['js-string'] } as any)
    return WebAssembly.instantiate(mod, {
        env: { print: () => {}, read: () => 0 },
        console: { log: (s: unknown) => log(String(s ?? '')), error: () => {} },
    })
}

describe('W2/W3: JSString via wasm:js-string builtins (Bun)', () => {
    test('build + concat + length runs host-native', async () => {
        const bin = buildBun(`\\\\ hi (Int) -> Int
@fn hi n := {
  \\\\ h JSString
  @local h := &JSString::fromCodePoint 72;
  \\\\ i JSString
  @local i := &JSString::fromCodePoint 105;
  \\\\ both JSString
  @local both := &JSString::concat h, i;
  &JSString::length both
};
@export hi;`)
        const inst = await instantiate(bin, () => {})
        expect((inst.exports as any).hi(0)).toBe(2)   // "H"+"i" → length 2
    })

    test('console::log prints a JS string through _start', async () => {
        const bin = buildBun(`\\\\ main () -> Void
@fn main := {
  \\\\ h JSString
  @local h := &JSString::fromCodePoint 72;
  \\\\ i JSString
  @local i := &JSString::fromCodePoint 105;
  &console::log (&JSString::concat h, i)
};
&main;`)
        let out = ''
        const inst = await instantiate(bin, s => { out += s })
        expect(typeof (inst.exports as any)._start).toBe('function')   // web/bun exports _start
        ;(inst.exports as any)._start()
        expect(out).toBe('Hi')
    })

    test('emits the wasm:js-string import module + externref signature', () => {
        const mods = loadModules(ROOT)
        const r = compile(`\\\\ f (Int) -> Int
@fn f n := &JSString::length (&JSString::fromCodePoint n);
@export f;`, { file: 'm.si', moduleRegistry: mods, target: 'host', platform: 'bun' } as any)
        expect(r.wat).toContain('(import "wasm:js-string" "fromCodePoint" (func $JSString__fromCodePoint (param i32) (result (ref extern))))')
        expect(r.wat).toContain('(import "wasm:js-string" "length" (func $JSString__length (param externref) (result i32)))')
    })
})
