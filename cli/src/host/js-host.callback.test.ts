// SPDX-License-Identifier: MIT
/**
 * Callback host bindings run through `runUnderBun` — the `closureToFn` wiring.
 *
 * A generated callback binding (events:'closure' — e.g. `global::queue_microtask`,
 * `fs::watch`, crypto's callback forms) wraps its closure-handle param with
 * `closureToFn(cb)` in the host shim.  That identifier used to be undefined in
 * `buildImports`, so any such call threw at runtime; `runUnderBun` now binds it
 * to `makeClosureToFn(instance)` after instantiate.  This hands a Silicon closure
 * to `global::queue_microtask` and asserts the run completes (exit 0) — the
 * closure is wrapped synchronously during `_start`.
 */
import { test, expect, describe } from 'bun:test'
import { compile, loadModules, resolveUses } from '@silicon/compiler'
import { runUnderBun } from './js-host'
import { resolve } from 'node:path'

const ENTRY = resolve(process.cwd(), 'entry.si')
const mods = loadModules(process.cwd())

describe('runUnderBun — callback bindings wire closureToFn', () => {
    test('a closure handed to global::queue_microtask is wrapped + scheduled (exit 0)', async () => {
        const { source } = resolveUses(`@use 'vec';
\\\\ noop (Int) -> Int
@fn noop x := { x };
\\\\ run () -> Void
@fn run := { global::queue_microtask(@export_callback(@closure(noop, 0))); };
run();`, ENTRY, { target: 'host' } as any)
        const r: any = compile(source, { file: ENTRY, moduleRegistry: mods, target: 'host', platform: 'bun', emitBinary: true } as any)
        expect(r.diagnostics ?? []).toEqual([])

        // closureToFn(callback) runs synchronously inside _start; before the wiring
        // it was `ReferenceError: closureToFn is not defined` → trap → exit 1.
        const code = await runUnderBun(r.binary)
        expect(code).toBe(0)
    })
})
