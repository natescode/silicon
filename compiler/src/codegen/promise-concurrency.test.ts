// SPDX-License-Identifier: MIT
/**
 * Next FFI work #4 — true concurrency over host I/O.
 *
 * A guest `@async @fn` kicks off N host operations WITHOUT awaiting them
 * (`js::apply` of a Promise-returning host fn returns the pending Promise as a
 * handle), collects the handles, and joins them with ONE `@await` of a host
 * Promise combinator (`promise::all` / `race` / `all_settled`).  The operations
 * run concurrently on the host; the guest resumes once they settle.
 *
 * Driven through the production reactor (`runWithReactor`).  The combinator
 * result is an externref array, so JSPI carries it (web/bun).
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
    from_int: (n: number) => n, as_int: (v: any) => (v | 0),
    get_index: (a: any, i: number) => (a == null ? null : (a[i] ?? null)),
    len: (v: any) => (v == null ? 0 : (v.length | 0)),
    apply: (fn: any, args: any) => { try { return fn(...(args ?? [])) } catch { return null } },
    null: () => null,
}

describe('next FFI #4 — concurrency via host Promise combinators', () => {
    // The guest starts two concurrent tasks (each `js::apply(task_fn, [n])`),
    // then joins them with `promise::all` and sums the two results.
    const RUN2 = `\\\\ @async run2 (JSValue) -> Int
@fn run2 task_fn := {
    \\\\ a1 JSValue
    @mut a1 := js::array();
    js::push(a1, js::from_int(10));
    \\\\ p1 JSValue
    @mut p1 := js::apply(task_fn, a1);
    \\\\ a2 JSValue
    @mut a2 := js::array();
    js::push(a2, js::from_int(32));
    \\\\ p2 JSValue
    @mut p2 := js::apply(task_fn, a2);
    \\\\ promises JSValue
    @mut promises := js::array();
    js::push(promises, p1);
    js::push(promises, p2);
    \\\\ results JSValue
    @mut results := @await(promise::all(promises));
    js::as_int(js::get_index(results, 0)) + js::as_int(js::get_index(results, 1))
};
@export run2;`

    test('promise::all joins two concurrently-started tasks (sum 42, both in-flight)', async () => {
        const { binary, suspending } = compileAsync(RUN2)
        expect(suspending).toContain('promise.all')

        let active = 0, maxActive = 0
        // Each task increments `active` synchronously (the executor runs when the
        // Promise is constructed), resolves to `n` after a tick.  Both tasks are
        // started before the await, so the peak concurrency is 2.
        const task = (n: number) => new Promise<number>(res => {
            active++; maxActive = Math.max(maxActive, active)
            setTimeout(() => { active--; res(n) }, 5)
        })
        const result = await runWithReactor(binary, {
            baseImports: { env: { print: () => {}, read: () => 0 }, js: jsHost },
            asyncImpls: { 'promise.all': (ps: any) => Promise.all(ps) },
            suspendingImports: ['promise.all'],
            entry: 'run2', args: [task as any],
            compileOptions: { builtins: ['js-string'] } as any,
        })
        expect(result).toBe(42)        // both results collected
        expect(maxActive).toBe(2)      // …and they were genuinely concurrent
    })

    test('promise::race resolves to the first task to settle', async () => {
        // run2 reused but joined with race instead; the faster task (smaller n
        // here resolves sooner) wins.  We sum get_index(0,0)+... but race returns
        // a single value, so read index 0 only.
        const RACE = RUN2.replace('promise::all', 'promise::race')
            .replace('js::as_int(js::get_index(results, 0)) + js::as_int(js::get_index(results, 1))',
                     'js::as_int(results)')
        const { binary, suspending } = compileAsync(RACE)
        expect(suspending).toContain('promise.race')

        // task(10) resolves in 30ms, task(32) in 5ms → 32 wins.
        const task = (n: number) => new Promise<number>(res => setTimeout(() => res(n), n === 10 ? 30 : 5))
        const result = await runWithReactor(binary, {
            baseImports: { env: { print: () => {}, read: () => 0 }, js: jsHost },
            asyncImpls: { 'promise.race': (ps: any) => Promise.race(ps) },
            suspendingImports: ['promise.race'],
            entry: 'run2', args: [task as any],
            compileOptions: { builtins: ['js-string'] } as any,
        })
        expect(result).toBe(32)        // the faster task won the race
    })

    test('promise::all_settled tolerates a rejecting task (length 2, no abort)', async () => {
        const SETTLED = `\\\\ @async run_settled (JSValue) -> Int
@fn run_settled task_fn := {
    \\\\ a1 JSValue
    @mut a1 := js::array();
    js::push(a1, js::from_int(1));
    \\\\ p1 JSValue
    @mut p1 := js::apply(task_fn, a1);
    \\\\ a2 JSValue
    @mut a2 := js::array();
    js::push(a2, js::from_int(0));
    \\\\ p2 JSValue
    @mut p2 := js::apply(task_fn, a2);
    \\\\ promises JSValue
    @mut promises := js::array();
    js::push(promises, p1);
    js::push(promises, p2);
    \\\\ results JSValue
    @mut results := @await(promise::all_settled(promises));
    js::len(results)
};
@export run_settled;`
        const { binary } = compileAsync(SETTLED)
        // task(1) resolves, task(0) rejects — allSettled keeps both outcomes.
        const task = (n: number) => n === 0 ? Promise.reject(new Error('boom')) : Promise.resolve(n)
        const result = await runWithReactor(binary, {
            baseImports: { env: { print: () => {}, read: () => 0 }, js: jsHost },
            asyncImpls: { 'promise.all_settled': (ps: any) => Promise.allSettled(ps) },
            suspendingImports: ['promise.all_settled'],
            entry: 'run_settled', args: [task as any],
            compileOptions: { builtins: ['js-string'] } as any,
        })
        expect(result).toBe(2)         // both settled outcomes returned, rejection didn't abort
    })
})
