// SPDX-License-Identifier: MIT
/**
 * Next FFI work #5 — generator harvest: the fetch ecosystem, end-to-end.
 *
 * Composes the harvested modules + the #1/#4 substrate into a real request
 * pipeline, WITHOUT any hand-written fetch binding:
 *
 *   fetch_fn  (a host global, passed in)         — js::apply kicks it off
 *   → Promise<Response>                          — promise::value awaits it
 *   → Response handle                            — response::json (@suspending)
 *   → parsed body (JSValue)                      — js::get / js::as_int read it
 *
 * Proves overload selection + the webiface `@suspending` body readers
 * (response::json/text) work against real host objects through the reactor.
 */
import { describe, test, expect } from 'bun:test'
import { resolve, dirname } from 'node:path'
import { compile } from '../caas/index'
import { loadModules } from '../modules/loader'
import { runWithReactor } from './async-reactor'

const ENTRY = resolve(__dirname, '../../entry.si')
const mods = loadModules(dirname(ENTRY))

function compileAsync(src: string): { binary: Uint8Array; suspending: string[] } {
    const r: any = compile(src, { file: ENTRY, moduleRegistry: mods, target: 'host', platform: 'bun', emitBinary: true } as any)
    expect(r.diagnostics ?? []).toEqual([])
    return { binary: r.binary, suspending: [...r.suspendingImports] }
}

const jsHost = {
    array: () => [], push: (a: any, v: any) => { a.push(v) },
    from_str: (s: any) => s, as_int: (v: any) => (v | 0),
    get: (o: any, k: any) => (o == null ? null : (o[k] ?? null)),
    apply: (fn: any, args: any) => { try { return fn(...(args ?? [])) } catch { return null } },
    null: () => null,
}
const responseHost = {
    status: (self: any) => self.status,
    json: (self: any) => self.json(),
    text: (self: any) => self.text(),
}

describe('next FFI #5 — fetch ecosystem end-to-end', () => {
    // Read `body[field]` from the JSON a fetch(url) resolves to.
    const FETCH_FIELD = `\\\\ @async fetch_field (JSValue, JSValue, JSString) -> Int
@fn fetch_field fetch_fn, url, field := {
    \\\\ args JSValue
    @mut args := js::array();
    js::push(args, url);
    \\\\ p JSValue
    @mut p := js::apply(fetch_fn, args);
    \\\\ resp JSValue
    @mut resp := @await(promise::value(p));
    \\\\ body JSValue
    @mut body := @await(response::json(resp));
    js::as_int(js::get(body, field))
};
@export fetch_field;`

    test('fetch → Response → json → field, all via harvested modules', async () => {
        const { binary, suspending } = compileAsync(FETCH_FIELD)
        // Two suspension points: awaiting the fetch Promise and the body reader.
        expect(suspending).toContain('promise.value')
        expect(suspending).toContain('response.json')

        // A mock `fetch` returning a real Response whose JSON body has `{count:42}`.
        const fetchFn = (_url: string) => Promise.resolve(new Response(JSON.stringify({ count: 42, other: 7 })))
        const result = await runWithReactor(binary, {
            baseImports: { env: { print: () => {}, read: () => 0 }, js: jsHost, response: responseHost },
            asyncImpls: {
                'promise.value': (p: any) => Promise.resolve(p),
                'response.json': (self: any) => self.json(),
            },
            suspendingImports: ['promise.value', 'response.json'],
            entry: 'fetch_field', args: [fetchFn as any, 'https://api.example/data' as any, 'count' as any],
            compileOptions: { builtins: ['js-string'] } as any,
        })
        expect(result).toBe(42)
    })

    test('response::status reads a sync accessor off a Response handle', async () => {
        const { binary } = compileAsync(`\\\\ st (JSValue) -> Int
@fn st resp := { response::status(resp) };
@export st;`)
        const inst = new WebAssembly.Instance(await WebAssembly.compile(binary), {
            env: { print: () => {}, read: () => 0 }, response: responseHost,
        })
        const resp = new Response('', { status: 204 })
        expect((inst.exports as any).st(resp)).toBe(204)
    })
})
