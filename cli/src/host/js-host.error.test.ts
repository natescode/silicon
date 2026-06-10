// SPDX-License-Identifier: MIT
/**
 * Next FFI work #2 — `runUnderBun` captures a Promise rejection at the boundary
 * instead of aborting the run (the production wiring of the async error bridge).
 *
 * A `@suspending @extern` whose impl rejects used to propagate out of the reactor
 * and make `runUnderBun` report an "async trap" (exit 1).  With the boundary
 * capture, the rejection is swallowed into the error slot and the awaited value
 * becomes a benign default, so the program runs to completion (exit 0) and guest
 * code can branch on `js::had_error()` instead of dying.
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

describe('runUnderBun — boundary capture of a suspending-import rejection', () => {
    test('a rejecting @suspending import is caught: run completes (exit 0), not a trap', async () => {
        const r = compileAsync(`\\\\ @suspending @extern load (Int) -> Int;
\\\\ @async run (Int) -> Int
@fn run x := { @await(load(x)) };
run(5);`)
        expect([...r.suspendingImports]).toEqual(['env.load'])

        let called = 0
        const code = await runUnderBun(r.binary, {
            suspendingImports: r.suspendingImports,
            hostAsync: { 'env.load': async () => { called++; await Promise.resolve(); throw new Error('network down') } },
        })
        expect(called).toBe(1)   // the import was actually driven
        expect(code).toBe(0)     // …and its rejection was captured, not propagated as a trap
    })

    test('a resolving @suspending import still runs to completion (no regression)', async () => {
        const r = compileAsync(`\\\\ @suspending @extern load (Int) -> Int;
\\\\ @async run (Int) -> Int
@fn run x := { @await(load(x)) };
run(5);`)
        const code = await runUnderBun(r.binary, {
            suspendingImports: r.suspendingImports,
            hostAsync: { 'env.load': async (x: number) => { await Promise.resolve(); return x + 1 } },
        })
        expect(code).toBe(0)
    })
})
