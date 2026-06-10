// SPDX-License-Identifier: MIT
/**
 * F3 — the Future ↔ host Promise bridge, end-to-end through the reactor.
 *
 * This is the substantive remaining piece of the poll-reactor: a guest-side
 * `Future` backed by a REAL host Promise, woken by the F1b reactor.  A
 * Promise-backed future reports Pending until its Promise settles;
 * `block_on_async` (@async) yields to the host event loop (`@await promise::tick`)
 * between poll rounds, so the Promise actually settles, then resumes and re-polls.
 * Driven by `runWithReactor`.
 */
import { describe, test, expect } from 'bun:test'
import { resolve, dirname } from 'node:path'
import { compile } from '../caas/index'
import { resolveUses } from '../modules/useResolver'
import { loadModules } from '../modules/loader'
import { runWithReactor } from './async-reactor'

const ENTRY = resolve(__dirname, '../../entry.si')
const mods = loadModules(dirname(ENTRY))

function compileAsync(src: string): { binary: Uint8Array; suspending: string[] } {
    const { source } = resolveUses(src, ENTRY, { target: 'host' })
    const r: any = compile(source, { file: ENTRY, moduleRegistry: mods, target: 'host', platform: 'bun', emitBinary: true } as any)
    expect(r.diagnostics ?? []).toEqual([])
    return { binary: r.binary, suspending: [...r.suspendingImports] }
}

/** The promise-tracking + js host (mirrors js-host.ts; tokens in a local table). */
function makeHost() {
    const pins: any[] = [null]
    const promise = {
        track: (p: any) => { const box = { done: 0, val: null as any }; Promise.resolve(p).then(v => { box.done = 1; box.val = v }, e => { box.done = 2; box.val = e }); pins.push(box); return pins.length - 1 },
        settled: (tok: number) => (pins[tok] && pins[tok].done) ? 1 : 0,
        result: (tok: number) => (pins[tok] ? pins[tok].val : null),
    }
    const js = { as_int: (v: any) => (v | 0) }
    return {
        baseImports: { env: { print: () => {}, read: () => 0 }, promise, js },
        // tick: yield one event-loop turn so tracked Promises can settle.
        asyncImpls: { 'promise.tick': () => new Promise<number>(r => setTimeout(() => r(0), 0)) },
    }
}

describe('F3 — Future ↔ host Promise bridge (reactor-woken)', () => {
    const RUN = `@use 'future_async';
\\\\ @async run (JSValue) -> Int
@fn run p := { block_on_async(promise_future(p)) };
@export run;`

    test('a future backed by a real (delayed) Promise resolves, woken by the reactor', async () => {
        const { binary, suspending } = compileAsync(RUN)
        expect(suspending).toContain('promise.tick')

        const host = makeHost()
        // A Promise that resolves to 42 only after a timer — the guest MUST yield
        // (via tick) for it to settle; a pure sync poll-loop would spin forever.
        const p = new Promise<number>(r => setTimeout(() => r(42), 5))
        const result = await runWithReactor(binary, {
            ...host, suspendingImports: ['promise.tick'],
            entry: 'run', args: [p as any],
            compileOptions: { builtins: ['js-string'] } as any,
        })
        expect(result).toBe(42)
    })

    test('an already-resolved Promise still flows through the bridge', async () => {
        const { binary } = compileAsync(RUN)
        const host = makeHost()
        const result = await runWithReactor(binary, {
            ...host, suspendingImports: ['promise.tick'],
            entry: 'run', args: [Promise.resolve(7) as any],
            compileOptions: { builtins: ['js-string'] } as any,
        })
        expect(result).toBe(7)
    })

    test('block_all_async drives TWO Promise-backed futures concurrently (guest-side)', async () => {
        // The guest itself joins two real Promises — not the host-delegated
        // promise::all path — polling both each round and yielding once so both
        // settle together.
        const { binary, suspending } = compileAsync(`@use 'future_async';
\\\\ @async run2 (JSValue, JSValue) -> Int
@fn run2 a, b := {
    futures := vec_new(2);
    vec_push_i32(futures, promise_future(a));
    vec_push_i32(futures, promise_future(b));
    block_all_async(futures)
};
@export run2;`)
        expect(suspending).toContain('promise.tick')

        const host = makeHost()
        let maxActive = 0, active = 0
        const task = (n: number, ms: number) => new Promise<number>(r => {
            active++; maxActive = Math.max(maxActive, active)
            setTimeout(() => { active--; r(n) }, ms)
        })
        const result = await runWithReactor(binary, {
            ...host, suspendingImports: ['promise.tick'],
            entry: 'run2', args: [task(10, 8) as any, task(32, 4) as any],
            compileOptions: { builtins: ['js-string'] } as any,
        })
        expect(result).toBe(42)        // 10 + 32, both joined by the guest
        expect(maxActive).toBe(2)      // …and genuinely in flight at the same time
    })
})
