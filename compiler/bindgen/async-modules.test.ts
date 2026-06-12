// SPDX-License-Identifier: MIT
/**
 * ADR 0017/0018 — the bindgen ASYNC tier, end-to-end.
 *
 * A `Promise<T>`-returning host method becomes a generated `@suspending @extern`
 * binding whose result is the AWAITED `T` (an externref — JSString/JSValue — since
 * the reactor returns the raw resolved value, with no host-side marshalling hook).
 * The `bun` module is generated with `async: 'suspending'`, so e.g.
 * `Bun.resolve(): Promise<string>` ships as `bun::resolve(JSString,JSString) ->
 * JSString` marked `@suspending`.
 *
 * A program `@await`ing such a binding drives through the F1b production reactor
 * (`runWithReactor`): the compiler reports the call in `suspendingImports`, and
 * the reactor suspends on the Promise and resumes with the resolved externref.
 * On Bun this takes the JSPI fast path (Binaryen's Asyncify can't carry externref
 * — binaryen#3739 — so an externref async result needs JSPI, which Bun 1.3 has).
 */

import { test, expect, describe } from 'bun:test'
import { compile, collectSuspendingImports } from '../src/caas/index'
import { loadModules } from '../src/modules/loader'
import { runWithReactor } from '../src/codegen/async-reactor'
import { dtsToSpecs } from './src/adapters/dts'

const mods = loadModules(process.cwd())

describe('bindgen async tier — @suspending bindings drive the reactor', () => {
    test('the dts adapter generates @suspending bindings from Promise-returning methods', () => {
        const { specs } = dtsToSpecs({ global: 'Bun', types: ['bun-types'], accessor: 'Bun', prefix: '', objects: 'jsvalue', async: 'suspending' })
        const resolve = specs.find(s => s.name === 'resolve')
        // Bun.resolve(): Promise<string>  ⇒  @suspending, awaited result String.
        expect(resolve?.suspending).toBe(true)
        expect(resolve?.result).toBe('String')
        // Promise<Response>/Promise<Blob> → JSValue (with objects:'jsvalue').
        expect(specs.find(s => s.name === 'readable_stream_to_blob')).toMatchObject({ suspending: true, result: 'JSValue' })
        // a sync method stays non-suspending.
        expect(specs.find(s => s.name === 'nanoseconds')?.suspending).toBeUndefined()
    })

    test('the generated bun.si module ships resolve as a @suspending binding the registry records', () => {
        // loadModules parsed bun.si; the binding carries the suspending flag.
        expect(mods.get('bun')?.functions.get('resolve')?.suspending).toBe(true)
        expect(mods.get('bun')?.functions.get('nanoseconds')?.suspending).toBeUndefined()
    })

    test('a program @awaiting a generated @suspending module binding runs through the reactor', async () => {
        const r: any = compile(`\\\\ @async fetch_id (JSString) -> JSString
@fn fetch_id url := { @await(bun::resolve(url, url)) };
@export fetch_id;`, { file: 'm.si', moduleRegistry: mods, target: 'host', platform: 'bun', emitBinary: true } as any)
        expect(r.diagnostics ?? []).toEqual([])
        // the suspending module CALL is collected (not just direct @extern decls).
        expect([...r.suspendingImports]).toEqual(['bun.resolve'])

        const out = await runWithReactor(r.binary, {
            baseImports: { env: { print: () => {}, read: () => 0 } },
            asyncImpls: { 'bun.resolve': async (id: string) => { await Promise.resolve(); return 'resolved:' + id } },
            suspendingImports: [...r.suspendingImports],
            entry: 'fetch_id', args: ['./mymod'] as any,
            compileOptions: { builtins: ['js-string'] } as any,
        })
        expect(out).toBe('resolved:./mymod')   // suspended on the Promise, resumed with the externref result
    })

    test('a direct @suspending @extern is collected too (bare → env.<field>)', () => {
        const r: any = compile(`\\\\ @suspending @extern fetch_json (JSString) -> JSValue;
\\\\ @async go (JSString) -> JSValue
@fn go u := { @await(fetch_json(u)) };
@export go;`, { file: 'm.si', moduleRegistry: mods, target: 'host', platform: 'bun', emitBinary: true } as any)
        expect(r.diagnostics ?? []).toEqual([])
        expect([...r.suspendingImports]).toEqual(['env.fetch_json'])
    })
})

void collectSuspendingImports   // (exercised indirectly via compile())
