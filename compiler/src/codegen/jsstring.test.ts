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

    test('String↔JSString bridge round-trips', async () => {
        const bin = buildBun(`\\\\ rt () -> Int
@fn rt := {
  \\\\ js JSString
  @local js := &JSString::fromString 'hi there';
  \\\\ back String
  @local back := &JSString::toString js;
  &str_len back
};
@export rt;`)
        const state: any = {}
        const readLen = (p: number) => { const v = new DataView(state.mem.buffer); const n = v.getInt32(p, true); return new TextDecoder().decode(new Uint8Array(state.mem.buffer, p + 4, n)) }
        const allocLen = (s: string) => { const b = new TextEncoder().encode(s); const p = state.alloc(4 + b.length); new DataView(state.mem.buffer).setInt32(p, b.length, true); new Uint8Array(state.mem.buffer, p + 4, b.length).set(b); return p }
        const mod = await WebAssembly.compile(bin, { builtins: ['js-string'] } as any)
        const inst = await WebAssembly.instantiate(mod, { env: { print: () => {}, read: () => 0 }, 'js-bridge': { fromString: readLen, toString: allocLen } })
        state.mem = (inst.exports as any).memory; state.alloc = (inst.exports as any).alloc
        expect((inst.exports as any).rt()).toBe(8)   // str_len(toString(fromString("hi there")))
    })

    test('JSString on platform=native is a clean error (not a silent miscompile)', () => {
        const mods = loadModules(ROOT)
        const r = compile(`\\\\ f () -> Int
@fn f := &JSString::length (&JSString::fromCodePoint 65);
@export f;`, { file: 'm.si', moduleRegistry: mods, target: 'host', platform: 'native', emitBinary: true } as any)
        expect(r.diagnostics.length).toBeGreaterThan(0)
        expect(r.diagnostics.some((d: any) => /JSString|--platform/.test(d.message))).toBe(true)
    })

    test('CharCodeArray ↔ JSString via fromCharCodeArray / intoCharCodeArray (GC i16 array)', async () => {
        // Build "Hi" from code units through a GC `(array (mut i16))`, then read a
        // JSString's units back out — both host-native under the js-string builtins.
        const bin = buildBun(`\\\\ probe () -> Int
@fn probe := {
  \\\\ arr CharCodeArray
  @local arr := &JSString::codeArray 2;
  &JSString::setCode arr, 0, 72;
  &JSString::setCode arr, 1, 105;
  \\\\ hi JSString
  @local hi := &JSString::fromCharCodeArray arr, 0, 2;
  \\\\ back CharCodeArray
  @local back := &JSString::codeArray 8;
  \\\\ n Int
  @local n := &JSString::intoCharCodeArray hi, back, 0;
  \\\\ result Int
  @local result := (&JSString::length hi) * 1000;
  result + ((&JSString::getCode back, 1) + ((&JSString::codeLen back) * 100000))
};
@export probe;`)
        const inst = await instantiate(bin, () => {})
        // length("Hi")=2 → 2000 ; getCode(back,1)='i'=105 ; codeLen(back)=8 → 800000
        expect((inst.exports as any).probe()).toBe(802105)
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
