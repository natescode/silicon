// SPDX-License-Identifier: MIT
/**
 * Next FFI work #3 — async iteration / streaming over host iterables.
 *
 * `stream::iter`/`next`/`value`/`done` drive the JS sync-iteration protocol so a
 * guest `@loop` pulls values one at a time from ANY host iterable (array, Set,
 * Map, generator).  `stream::aiter`/`anext` (the latter `@suspending`) do the
 * same for async iterables (async generators / ReadableStream), driven by the
 * reactor.  Values cross as `externref`; unbox with the `js` module.
 */
import { describe, test, expect } from 'bun:test'
import { resolve, dirname } from 'node:path'
import { compile } from '../caas/index'
import { loadModules } from '../modules/loader'
import { runWithReactor } from './async-reactor'

const ENTRY = resolve(__dirname, '../../entry.si')
const mods = loadModules(dirname(ENTRY))

function compileBin(src: string): Uint8Array {
    const r: any = compile(src, { file: ENTRY, moduleRegistry: mods, target: 'host', platform: 'bun', emitBinary: true } as any)
    expect(r.diagnostics ?? []).toEqual([])
    return r.binary
}

const jsHost = {
    as_int: (v: any) => (v | 0), as_float: (v: any) => +v, is_null: (v: any) => (v == null ? 1 : 0),
    null: () => null, from_int: (n: number) => n,
}
const streamHost = {
    iter: (it: any) => it[Symbol.iterator](),
    next: (it: any) => it.next(),
    value: (step: any) => (step == null ? null : (step.value ?? null)),
    done: (step: any) => (step != null && step.done ? 1 : 0),
    aiter: (it: any) => it[Symbol.asyncIterator](),
    anext: (it: any) => it.next(),
}
const baseImports = { env: { print: () => {}, read: () => 0 }, js: jsHost, stream: streamHost }

// A guest that sums every element of a host iterable via the sync protocol.
const SUM_ITER = `\\\\ sum_iter (JSValue) -> Int
@fn sum_iter coll := {
    \\\\ it JSValue
    @mut it := stream::iter(coll);
    @mut total := 0;
    @mut more := 1;
    @loop(more, {
        \\\\ step JSValue
        @mut step := stream::next(it);
        @if(stream::done(step), {
            more = 0;
        }, {
            total = total + js::as_int(stream::value(step));
        });
    });
    total
};
@export sum_iter;`

describe('next FFI #3 — sync iteration over host iterables', () => {
    test('sums a JS array, an exact element-by-element pull', async () => {
        const ex = (await WebAssembly.instantiate(await WebAssembly.compile(compileBin(SUM_ITER)), baseImports)).exports as any
        expect(ex.sum_iter([10, 20, 30])).toBe(60)
        expect(ex.sum_iter([])).toBe(0)             // empty iterable → done immediately
        expect(ex.sum_iter([7])).toBe(7)
    })

    test('works over ANY iterable: Set, Map values, a generator', async () => {
        const ex = (await WebAssembly.instantiate(await WebAssembly.compile(compileBin(SUM_ITER)), baseImports)).exports as any
        expect(ex.sum_iter(new Set([1, 2, 3, 4]))).toBe(10)
        function* gen() { yield 5; yield 15; yield 25 }
        expect(ex.sum_iter(gen())).toBe(45)
        expect(ex.sum_iter(new Map([['a', 100], ['b', 200]]).values())).toBe(300)
    })

    test('counts elements (done-detection), independent of value', async () => {
        const ex = (await WebAssembly.instantiate(await WebAssembly.compile(compileBin(`\\\\ count (JSValue) -> Int
@fn count coll := {
    \\\\ it JSValue
    @mut it := stream::iter(coll);
    @mut n := 0;
    @mut more := 1;
    @loop(more, {
        \\\\ step JSValue
        @mut step := stream::next(it);
        @if(stream::done(step), { more = 0; }, { n = n + 1; });
    });
    n
};
@export count;`)), baseImports)).exports as any
        expect(ex.count(['a', 'b', 'c', 'd', 'e'])).toBe(5)
        expect(ex.count('hello')).toBe(5)   // strings are iterable too
    })
})

describe('next FFI #3 — async iteration (reactor)', () => {
    const ASYNC_SUM = `\\\\ @async sum_async (JSValue) -> Int
@fn sum_async it := {
    @mut total := 0;
    @mut more := 1;
    @loop(more, {
        \\\\ step JSValue
        @mut step := @await(stream::anext(it));
        @if(stream::done(step), {
            more = 0;
        }, {
            total = total + js::as_int(stream::value(step));
        });
    });
    total
};
@export sum_async;`

    test('sums an async generator, pulling each value through the reactor', async () => {
        const r: any = compile(ASYNC_SUM, { file: ENTRY, moduleRegistry: mods, target: 'host', platform: 'bun', emitBinary: true } as any)
        expect(r.diagnostics ?? []).toEqual([])
        expect([...r.suspendingImports]).toContain('stream.anext')

        async function* agen() { yield 11; yield 22; yield 33 }
        const it = agen()
        const result = await runWithReactor(r.binary, {
            baseImports,
            // `anext` is the only suspending import; drive it through the reactor.
            asyncImpls: { 'stream.anext': async () => it.next() },
            suspendingImports: ['stream.anext'],
            entry: 'sum_async', args: [it as any],
            compileOptions: { builtins: ['js-string'] } as any,
        })
        expect(result).toBe(66)
    })
})
