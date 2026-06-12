// SPDX-License-Identifier: MIT
/**
 * FFI follow-up #4 — bare-global function harvest (fetch / atob / btoa).
 *
 * The dts bare-global mode harvests top-level globals the namespace adapters
 * can't reach.  `global::fetch` is now FIRST-CLASS (@suspending, Promise<Response>
 * → JSValue) instead of the js::global('fetch') + js::apply composition; atob/btoa
 * are sync string codecs.
 */
import { describe, test, expect } from 'bun:test'
import { compile } from '../caas/index'
import { loadModules } from '../modules/loader'
import { runWithReactor } from './async-reactor'

const mods = loadModules(process.cwd())

function compileBin(src: string): { binary: Uint8Array; suspending: string[] } {
    const r: any = compile(src, { file: 'm.si', moduleRegistry: mods, target: 'host', platform: 'bun', emitBinary: true } as any)
    expect(r.diagnostics ?? []).toEqual([])
    return { binary: r.binary, suspending: [...r.suspendingImports] }
}

describe('FFI #4 — bare-global harvest', () => {
    test('global::atob / global::btoa round-trip base64 (sync)', async () => {
        const { binary } = compileBin(`\\\\ enc (JSString) -> JSString
@fn enc s := { global::btoa(s) };
\\\\ dec (JSString) -> JSString
@fn dec s := { global::atob(s) };
@export enc;
@export dec;`)
        const inst = new WebAssembly.Instance(await WebAssembly.compile(binary, { builtins: ['js-string'] } as any), {
            env: { print: () => {}, read: () => 0 },
            global: { atob: (d: any) => globalThis.atob(d), btoa: (d: any) => globalThis.btoa(d) },
        })
        const ex = inst.exports as any
        expect(ex.enc('hello')).toBe(btoa('hello'))         // 'aGVsbG8='
        expect(ex.dec(btoa('hello'))).toBe('hello')
    })

    test('global::fetch is first-class @suspending → Response, driven by the reactor', async () => {
        const { binary, suspending } = compileBin(`\\\\ @async fetch_status (JSString, JSValue) -> Int
@fn fetch_status url, init := {
    \\\\ resp JSValue
    @mut resp := @await(global::fetch(url, init));
    response::status(resp)
};
@export fetch_status;`)
        expect(suspending).toContain('global.fetch')

        let calledWith = ''
        const result = await runWithReactor(binary, {
            baseImports: {
                env: { print: () => {}, read: () => 0 },
                js: { null: () => null },
                response: { status: (self: any) => self.status },
            },
            asyncImpls: {
                'global.fetch': (url: any) => { calledWith = String(url); return Promise.resolve(new Response('', { status: 201 })) },
            },
            suspendingImports: ['global.fetch'],
            entry: 'fetch_status', args: ['https://api.example/x' as any, null as any],
            compileOptions: { builtins: ['js-string'] } as any,
        })
        expect(result).toBe(201)                               // Response.status read off the fetched handle
        expect(calledWith).toBe('https://api.example/x')       // the URL crossed as a JSString
    })
})
