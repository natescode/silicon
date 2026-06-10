// SPDX-License-Identifier: MIT
/**
 * Next FFI work #2 — host-error → Silicon `Result` (the @try-at-the-boundary
 * bridge), synchronous path.
 *
 * A fallible host call routed through `js::call`/`js::apply`/`js::construct`
 * catches a thrown host exception into the boundary error slot and returns null
 * instead of trapping; the stdlib `ffi` helpers (`js_check`/`js_try`) lift that
 * outcome into a `Result[Int, String]`.  The error is a linear `String` (the
 * host message); the success value stays in a guest local or is pinned by id.
 */
import { describe, test, expect } from 'bun:test'
import { resolve, dirname } from 'node:path'
import { compile } from '../caas/index'
import { resolveUses } from '../modules/useResolver'
import { loadModules } from '../modules/loader'

const ENTRY = resolve(__dirname, '../../entry.si')
const mods = loadModules(dirname(ENTRY))

function compileBin(src: string): Uint8Array {
    const { source } = resolveUses(src, ENTRY, { target: 'host' })
    const r: any = compile(source, { file: ENTRY, moduleRegistry: mods, target: 'host', platform: 'bun', emitBinary: true } as any)
    expect(r.diagnostics ?? []).toEqual([])
    return r.binary
}

/** Build a host whose `js` shim shares one error slot + pin table, with a linear
 *  `error_message` that marshals into the instance memory (mirrors js-host.ts). */
function makeHost() {
    const state: { memory?: WebAssembly.Memory; alloc?: (n: number) => number } = {}
    const errBox: { last: any } = { last: null }
    const pins: any[] = [null]
    const allocLenString = (s: string): number => {
        const bytes = new TextEncoder().encode(s)
        const ptr = state.alloc!(4 + bytes.length)
        const v = new DataView(state.memory!.buffer)
        v.setInt32(ptr, bytes.length, true)
        new Uint8Array(state.memory!.buffer, ptr + 4, bytes.length).set(bytes)
        return ptr
    }
    const readLenString = (ptr: number): string => {
        const v = new DataView(state.memory!.buffer)
        const len = v.getInt32(ptr, true)
        return new TextDecoder().decode(new Uint8Array(state.memory!.buffer, ptr + 4, len))
    }
    const js = {
        object: () => ({}), array: () => [], null: () => null, undefined: () => undefined,
        set: (o: any, k: any, v: any) => { o[k] = v },
        push: (a: any, v: any) => { a.push(v) },
        get: (o: any, k: any) => (o == null ? null : (o[k] ?? null)),
        from_int: (n: number) => n, from_str: (s: any) => s,
        as_int: (v: any) => (v | 0), as_str: (v: any) => String(v),
        global: (name: any) => (globalThis as any)[name],
        is_null: (v: any) => (v == null ? 1 : 0),
        call: (recv: any, method: any, args: any) => {
            errBox.last = null
            try { return recv[method](...(args ?? [])) } catch (e) { errBox.last = e; return null }
        },
        apply: (fn: any, args: any) => {
            errBox.last = null
            try { return fn(...(args ?? [])) } catch (e) { errBox.last = e; return null }
        },
        construct: (ctor: any, args: any) => {
            errBox.last = null
            try { return new ctor(...(args ?? [])) } catch (e) { errBox.last = e; return null }
        },
        had_error: () => (errBox.last != null ? 1 : 0),
        take_error: () => { const e = errBox.last; errBox.last = null; return e ?? null },
        error_message: () => {
            const e = errBox.last; errBox.last = null
            return allocLenString(e == null ? '' : String((e && e.message) != null ? e.message : e))
        },
        clear_error: () => { errBox.last = null },
        pin: (v: any) => { pins.push(v); return pins.length - 1 },
        pinned: (i: number) => (pins[i] ?? null),
        unpin: (i: number) => { if (i > 0 && i < pins.length) pins[i] = null },
    }
    const imports = { env: { print: () => {}, read: () => 0 }, js }
    return { imports, readLenString, bind: (inst: WebAssembly.Instance) => { state.memory = (inst.exports as any).memory; state.alloc = (inst.exports as any).alloc } }
}

async function instantiate(bin: Uint8Array) {
    const host = makeHost()
    const inst = new WebAssembly.Instance(await WebAssembly.compile(bin), host.imports)
    host.bind(inst)
    return { ex: inst.exports as any, host }
}

describe('next FFI #2 — host-error → Result (sync boundary)', () => {
    test('js::call of a throwing method → Err; of a good method → Ok', async () => {
        const { ex } = await instantiate(compileBin(`@use 'ffi';
\\\\ probe (JSValue, JSString, JSValue) -> Int
@fn probe recv, method, args := {
    js::call(recv, method, args);
    \\\\ r Result[Int, String]
    @mut r := js_check(0);
    @match(r, $Ok _ok, { 0 }, $Err _m, { 1 })
};
@export probe;`))
        const obj = { good: () => 42, bad: () => { throw new Error('boom') } }
        expect(ex.probe(obj, 'good', [])).toBe(0)   // Ok — no error
        expect(ex.probe(obj, 'bad', [])).toBe(1)    // Err — caught, not trapped
    })

    test('the caught error message reaches the guest as a linear String', async () => {
        const { ex, host } = await instantiate(compileBin(`@use 'ffi';
\\\\ run_msg (JSValue, JSString, JSValue) -> String
@fn run_msg recv, method, args := {
    js::call(recv, method, args);
    js::error_message()
};
@export run_msg;`))
        const obj = { bad: () => { throw new Error('bad input') }, good: () => 1 }
        expect(host.readLenString(ex.run_msg(obj, 'bad', []))).toBe('bad input')
        // A successful call leaves the slot clear → empty message.
        expect(host.readLenString(ex.run_msg(obj, 'good', []))).toBe('')
    })

    test('pin / pinned round-trips a handle through an Int id', async () => {
        const { ex } = await instantiate(compileBin(`@use 'ffi';
\\\\ pin_rt (JSValue) -> JSValue
@fn pin_rt v := {
    \\\\ id Int
    @mut id := js::pin(v);
    js::pinned(id)
};
@export pin_rt;`))
        const sentinel = { tag: 'ok-value' }
        expect(ex.pin_rt(sentinel)).toBe(sentinel)   // same object handle back
    })

    test('js_try(handle) carries the handle by id: Ok(pin id ≥ 1) / Err on throw', async () => {
        // js_try takes the JSValue handle directly (an externref-param helper
        // that builds + matches a Result — works now the flat @match form landed).
        const { ex } = await instantiate(compileBin(`@use 'ffi';
\\\\ try_id (JSValue, JSString, JSValue) -> Int
@fn try_id recv, method, args := {
    \\\\ r JSValue
    @mut r := js::call(recv, method, args);
    \\\\ res Result[Int, String]
    @mut res := js_try(r);
    @match(res, $Ok id, { id }, $Err _m, { 0 - 1 })
};
@export try_id;`))
        const obj = { good: () => ({}), bad: () => { throw new Error('x') } }
        const goodId = ex.try_id(obj, 'good', [])
        expect(goodId).toBeGreaterThanOrEqual(1)   // Ok(pin id)
        expect(ex.try_id(obj, 'bad', [])).toBe(-1)                     // Err
    })

    test('INTEGRATION: JSON.parse of bad input is caught, not a trap', async () => {
        // The real win: a fallible host API (JSON.parse) called via js::apply
        // surfaces malformed input as Err(message) instead of trapping the module.
        const { ex } = await instantiate(compileBin(`@use 'ffi';
\\\\ parse_ok (JSValue, JSString) -> Int
@fn parse_ok parse_fn, text := {
    \\\\ args JSValue
    @mut args := js::array();
    js::push(args, js::from_str(text));
    js::apply(parse_fn, args);
    \\\\ r Result[Int, String]
    @mut r := js_check(0);
    @match(r, $Ok _ok, { 1 }, $Err _m, { 0 })
};
@export parse_ok;`))
        const parse = JSON.parse
        expect(ex.parse_ok(parse, '{"a":1}')).toBe(1)   // valid JSON → Ok
        expect(ex.parse_ok(parse, 'not json')).toBe(0)  // invalid → Err, caught
    })
})
