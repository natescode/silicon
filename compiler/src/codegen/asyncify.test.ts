// SPDX-License-Identifier: MIT
/**
 * ADR 0018 Phase 1 — blocking `@await` via Asyncify, end-to-end.
 *
 * A Silicon `@fn` `@await`s a host-async import; the program is compiled, run
 * through Binaryen's Asyncify pass (`applyAsyncify`), and driven by the host
 * reactor (`createAsyncReactor`): the import returns a Promise, the guest
 * suspends (unwind), the host awaits it, then rewinds and resumes — straight-line
 * synchronous-looking Silicon source over an asynchronous host call, on Bun.
 */

import { test, expect, describe } from 'bun:test'
import { compile } from '../caas/index'
import { loadModules } from '../modules/loader'
import { applyAsyncify } from './asyncify'
import { createAsyncReactor } from './async-reactor'

const mods = loadModules(process.cwd())

function compileBin(src: string): Uint8Array {
    const r: any = compile(src, { file: 'm.si', moduleRegistry: mods, target: 'host', platform: 'bun', emitBinary: true } as any)
    expect(r.diagnostics ?? []).toEqual([])
    return r.binary
}

describe('ADR 0018 — blocking @await (Asyncify baseline)', () => {
    test('a single @await on a host-async import suspends, awaits, and resumes', async () => {
        const bin = applyAsyncify(compileBin(`\\\\ @extern async_double (Int) -> Int;
\\\\ fetch_inc (Int) -> Int
@fn fetch_inc x := { @await(async_double(x)) + 1 };
@export fetch_inc;`))

        // async_double resolves asynchronously to x*2 (a real Promise tick).
        const reactor = createAsyncReactor({
            async_double: async (x: number) => { await Promise.resolve(); return x * 2 },
        })
        const instance = await WebAssembly.instantiate(
            await WebAssembly.compile(bin),
            { env: { print: () => {}, read: () => 0, ...reactor.imports } },
        )
        reactor.bind(instance)
        expect(await reactor.run(() => (instance.exports as any).fetch_inc(5))).toBe(11)   // 5*2 + 1
        expect(await reactor.run(() => (instance.exports as any).fetch_inc(20))).toBe(41)  // 20*2 + 1
    })

    test('two @await suspensions in one function chain through the reactor', async () => {
        const bin = applyAsyncify(compileBin(`\\\\ @extern step (Int) -> Int;
\\\\ pipeline (Int) -> Int
@fn pipeline x := {
    a := @await(step(x));
    b := @await(step(a));
    b + 100
};
@export pipeline;`))

        // step resolves asynchronously to x+1, twice.
        const reactor = createAsyncReactor({
            step: async (x: number) => { await Promise.resolve(); return x + 1 },
        })
        const instance = await WebAssembly.instantiate(
            await WebAssembly.compile(bin),
            { env: { print: () => {}, read: () => 0, ...reactor.imports } },
        )
        reactor.bind(instance)
        // step(7)=8, step(8)=9, +100 = 109 — two separate suspensions resolved in order.
        expect(await reactor.run(() => (instance.exports as any).pipeline(7))).toBe(109)
    })

    test('the Asyncify pass adds the reactor control exports', () => {
        const bin = applyAsyncify(compileBin(`\\\\ @extern a (Int) -> Int;
\\\\ f (Int) -> Int
@fn f x := { @await(a(x)) };
@export f;`))
        // The instrumented module exposes the unwind/rewind state machine.
        // (Validate by instantiating and checking the exports exist.)
        return WebAssembly.instantiate(bin, { env: { print: () => {}, read: () => 0, a: () => 0 } })
            .then(m => {
                const e = m.instance.exports as any
                expect(typeof e.asyncify_start_unwind).toBe('function')
                expect(typeof e.asyncify_get_state).toBe('function')
            })
    })
})
