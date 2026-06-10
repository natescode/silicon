// SPDX-License-Identifier: MIT
/**
 * Next FFI work #2 — host-error → Silicon `Result`, ASYNC path.
 *
 * A `@suspending @extern` whose Promise REJECTS would otherwise abort the whole
 * run.  The host wraps each suspending import so a rejection is captured into the
 * boundary error slot and the awaited value becomes `null` — exactly like a sync
 * throw — so guest code reads `js::had_error()` after the `@await` and lifts it
 * into a `Result` (stdlib `ffi.si`).  This drives the production reactor
 * (`runWithReactor`, JSPI or Asyncify) with a rejecting import and asserts the
 * guest sees Err, while a resolving import yields Ok.
 *
 * Int results keep it backend-agnostic (Asyncify can't carry an externref).
 */
import { describe, test, expect } from 'bun:test'
import { resolve, dirname } from 'node:path'
import { compile } from '../caas/index'
import { resolveUses } from '../modules/useResolver'
import { loadModules } from '../modules/loader'
import { runWithReactor } from './async-reactor'

const ENTRY = resolve(__dirname, '../../entry.si')
const mods = loadModules(dirname(ENTRY))

/** A program that awaits a suspending import, then maps the boundary outcome to
 *  1 (Ok) / 0 (Err) through the stdlib `ffi` bridge. */
const SRC = `@use 'ffi';
\\\\ @suspending @extern load (Int) -> Int;
\\\\ @async run (Int) -> Int
@fn run x := {
    \\\\ n Int
    @mut n := @await(load(x));
    \\\\ res Result[Int, String]
    @mut res := js_check(0);
    @match(res, $Ok _ok => 1, $Err _m => 0)
};
@export run;`

function compileAsync(): { binary: Uint8Array; suspending: string[] } {
    const { source } = resolveUses(SRC, ENTRY, { target: 'host' })
    const r: any = compile(source, { file: ENTRY, moduleRegistry: mods, target: 'host', platform: 'bun', emitBinary: true } as any)
    expect(r.diagnostics ?? []).toEqual([])
    return { binary: r.binary, suspending: [...r.suspendingImports] }
}

/** Mirror js-host.ts: wrap an async impl so a rejection is captured, not thrown. */
function makeHost() {
    const errBox: { last: any } = { last: null }
    const js: any = {
        had_error: () => (errBox.last != null ? 1 : 0),
        error_message: () => 0,   // not exercised here (Err arm ignores the message)
        clear_error: () => { errBox.last = null },
        // the rest of `js` is referenced by the inlined (dead) ffi helpers; stub them
        pin: () => 0, pinned: () => null, unpin: () => {}, take_error: () => null,
    }
    const capture = (fn: (...a: number[]) => any) => async (...a: number[]) => {
        errBox.last = null
        try { return await fn(...a) } catch (e) { errBox.last = e; return null }
    }
    return { errBox, js, capture, baseImports: { env: { print: () => {}, read: () => 0 }, js } }
}

describe('next FFI #2 — host-error → Result (async boundary)', () => {
    test('a resolving suspending import → Ok', async () => {
        const { binary, suspending } = compileAsync()
        expect(suspending).toEqual(['env.load'])
        const host = makeHost()
        const result = await runWithReactor(binary, {
            baseImports: host.baseImports,
            asyncImpls: { 'env.load': host.capture(async (x: number) => { await Promise.resolve(); return x + 1 }) },
            suspendingImports: ['env.load'],
            entry: 'run', args: [5],
            compileOptions: { builtins: ['js-string'] } as any,
        })
        expect(result).toBe(1)   // resolved → no boundary error → Ok
    })

    test('a REJECTING suspending import is caught → Err (no trap, no abort)', async () => {
        const { binary } = compileAsync()
        const host = makeHost()
        const result = await runWithReactor(binary, {
            baseImports: host.baseImports,
            asyncImpls: { 'env.load': host.capture(async (_x: number) => { await Promise.resolve(); throw new Error('network down') }) },
            suspendingImports: ['env.load'],
            entry: 'run', args: [5],
            compileOptions: { builtins: ['js-string'] } as any,
        })
        expect(result).toBe(0)              // rejection captured → Err arm taken
        expect(host.errBox.last).toBeTruthy()  // the boundary slot holds the rejection
    })
})
