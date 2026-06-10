// SPDX-License-Identifier: MIT
/**
 * ADR 0018 §3 P2/P5 — the PRODUCTION async path, end-to-end.
 *
 * Unlike asyncify.test.ts (which calls `applyAsyncify` by hand), this exercises
 * the real `sgl run` flow: a VANILLA binary is compiled from `@async`/`@await`/
 * `@suspending`-marked source, the compiler reports its `suspendingImports`, and
 * `runWithReactor` picks the backend at load time — JSPI fast path where the
 * engine has it, else Asyncify route-B precise coloring driven by the reactor.
 * On Bun (no JSPI) this takes the Asyncify branch.
 */

import { test, expect, describe } from 'bun:test'
import { compile, collectSuspendingImports, parse } from '../caas/index'
import { loadModules } from '../modules/loader'
import { runWithReactor, hasJSPI } from './async-reactor'

const mods = loadModules(process.cwd())

function compileSrc(src: string) {
    const r: any = compile(src, { file: 'm.si', moduleRegistry: mods, target: 'host', platform: 'bun', emitBinary: true } as any)
    expect(r.diagnostics ?? []).toEqual([])
    return r
}

const base = { env: { print: () => {}, read: () => 0 } }

describe('ADR 0018 — production async reactor (vanilla binary, load-time backend)', () => {
    test('the compiler reports @suspending imports as module.field metadata', () => {
        const r = compileSrc(`\\\\ @suspending @extern fetch_double (Int) -> Int;
\\\\ @suspending @extern http::get (Int) -> Int;
\\\\ @async run (Int) -> Int
@fn run x := { @await(fetch_double(x)) + @await(http::get(x)) };
@export run;`)
        // bare extern → env.<field>; namespaced mod::field → mod.field
        expect([...r.suspendingImports].sort()).toEqual(['env.fetch_double', 'http.get'])
    })

    test('a non-async program reports no suspending imports', () => {
        const r = compileSrc(`\\\\ add (Int, Int) -> Int
@fn add a, b := { a + b };
@export add;`)
        expect(r.suspendingImports).toEqual([])
    })

    // The SAME vanilla binary runs under BOTH backends (load-time choice).  Bun
    // 1.3.14 has JSPI, so the 'auto' path takes the JSPI branch here; we force
    // each backend explicitly so both are covered regardless of engine.
    for (const backend of ['asyncify', 'jspi', 'auto'] as const) {
        test(`runWithReactor drives a vanilla binary (backend=${backend})`, async () => {
            const r = compileSrc(`\\\\ @suspending @extern fetch_double (Int) -> Int;
\\\\ @async run (Int) -> Int
@fn run x := { @await(fetch_double(x)) + 1 };
@export run;`)
            if (backend === 'jspi' && !hasJSPI()) return   // skip JSPI where the engine lacks it
            const out = await runWithReactor(r.binary, {
                baseImports: base,
                asyncImpls: { 'env.fetch_double': async (x: number) => { await Promise.resolve(); return x * 2 } },
                suspendingImports: [...r.suspendingImports],
                entry: 'run',
                args: [5],
                backend,
            })
            expect(out).toBe(11)   // 5*2 + 1, suspended and resumed (same source, either backend)
        })
    }

    test('two suspensions chain through the production reactor (Asyncify multi-suspend)', async () => {
        const r = compileSrc(`\\\\ @suspending @extern step (Int) -> Int;
\\\\ @async pipeline (Int) -> Int
@fn pipeline x := {
    a := @await(step(x));
    b := @await(step(a));
    b + 100
};
@export pipeline;`)
        const out = await runWithReactor(r.binary, {
            baseImports: base,
            asyncImpls: { 'env.step': async (x: number) => { await Promise.resolve(); return x + 1 } },
            suspendingImports: [...r.suspendingImports],
            entry: 'pipeline',
            args: [7],
            backend: 'asyncify',   // exercise the unwind/rewind multi-suspend path explicitly
        })
        expect(out).toBe(109)   // step(7)=8, step(8)=9, +100
    })

    test('collectSuspendingImports is a pure function over the parsed program', () => {
        const { tree } = parse(`\\\\ @suspending @extern a (Int) -> Int;\n\\\\ b (Int) -> Int\n@fn b x := { x };`)
        expect(collectSuspendingImports((tree as any).program)).toEqual(['env.a'])
    })
})
