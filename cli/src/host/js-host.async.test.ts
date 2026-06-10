// SPDX-License-Identifier: MIT
/**
 * ADR 0018 §3 P2 — `runUnderBun` (the real `sgl run` host) drives a program with
 * `@suspending` imports through the async reactor instead of a one-shot `_start`.
 *
 * Proves the production wiring: a vanilla binary compiled from `@async`/`@await`/
 * `@suspending` source, its `suspendingImports` threaded in, runs to completion —
 * the suspending import is actually awaited and resumed (not trapped or skipped).
 */

import { test, expect, describe } from 'bun:test'
import { compile, loadModules } from '@silicon/compiler'
import { runUnderBun } from './js-host'

const mods = loadModules(process.cwd())

function compileAsync(src: string) {
    const r: any = compile(src, { file: 'm.si', moduleRegistry: mods, target: 'host', platform: 'bun', emitBinary: true } as any)
    expect(r.diagnostics ?? []).toEqual([])
    return r
}

describe('runUnderBun — production async reactor wiring', () => {
    test('a top-level @async call with a @suspending import runs through the reactor', async () => {
        const r = compileAsync(`\\\\ @suspending @extern async_inc (Int) -> Int;
\\\\ @async compute (Int) -> Int
@fn compute x := { @await(async_inc(x)) };
compute(7);`)
        expect([...r.suspendingImports]).toEqual(['env.async_inc'])

        let called = 0
        const code = await runUnderBun(r.binary, {
            suspendingImports: r.suspendingImports,
            hostAsync: { 'env.async_inc': async (x: number) => { called++; await Promise.resolve(); return x + 1 } },
        })
        expect(code).toBe(0)        // ran to completion, no trap
        expect(called).toBe(1)      // the suspending import was actually driven (awaited + resumed)
    })

    test('a non-async program still runs via the one-shot path (no regression)', async () => {
        const r = compileAsync(`\\\\ noop () -> Int
@fn noop := { 0 };
noop();`)
        expect([...r.suspendingImports]).toEqual([])
        expect(await runUnderBun(r.binary)).toBe(0)
    })
})
