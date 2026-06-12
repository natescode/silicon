// SPDX-License-Identifier: MIT
/**
 * Next FFI work #1 — the generic object/array build-and-read surface (`js`).
 *
 * `js::object()`/`js::array()`/`js::set`/`js::push`/`js::get`/`js::from_*`/
 * `js::as_*` let guest code CONSTRUCT JS objects/arrays to pass into host APIs
 * (options bags) and INSPECT the handles they hand back — closing the two
 * reflection gaps that left most JSValue-returning APIs uncallable.  Every value
 * crosses as an `externref`; scalars box/unbox through the from_x / as_x pairs.
 *
 * The host `js:` shim under test mirrors cli/src/host/js-host.ts exactly.
 */
import { describe, test, expect } from 'bun:test'
import { compile } from '../caas/index'
import { loadModules } from '../modules/loader'

const mods = loadModules(process.cwd())

function compileBin(src: string): Uint8Array {
    const r: any = compile(src, { file: 'm.si', moduleRegistry: mods, target: 'host', platform: 'bun', emitBinary: true } as any)
    expect(r.diagnostics ?? []).toEqual([])
    return r.binary
}

/** The `js:` host object — a verbatim copy of the shim in js-host.ts. */
const jsHost = {
    object: () => ({}),
    array: () => [],
    null: () => null,
    undefined: () => undefined,
    set: (o: any, k: any, v: any) => { o[k] = v },
    set_index: (a: any, i: number, v: any) => { a[i] = v },
    push: (a: any, v: any) => { a.push(v) },
    get: (o: any, k: any) => (o == null ? null : (o[k] ?? null)),
    get_index: (a: any, i: number) => (a == null ? null : (a[i] ?? null)),
    len: (v: any) => (v == null ? 0 : (v.length | 0)),
    has: (o: any, k: any) => (o != null && (k in Object(o))) ? 1 : 0,
    keys: (o: any) => (o == null ? [] : Object.keys(o)),
    typeof: (v: any) => Array.isArray(v) ? 'array' : (v === null ? 'null' : typeof v),
    is_null: (v: any) => (v == null) ? 1 : 0,
    from_int: (n: number) => n,
    from_float: (n: number) => n,
    from_bool: (b: number) => b !== 0,
    from_str: (s: any) => s,
    as_int: (v: any) => (v | 0),
    as_float: (v: any) => +v,
    as_bool: (v: any) => v ? 1 : 0,
    as_str: (v: any) => String(v),
    global: (name: any) => (globalThis as any)[name],
}

const baseImports = { env: { print: () => {}, read: () => 0 }, js: jsHost }

async function inst(bin: Uint8Array, extra: Record<string, any> = {}) {
    const i = new WebAssembly.Instance(await WebAssembly.compile(bin), { ...baseImports, ...extra })
    return i.exports as any
}

describe('next FFI #1 — object/array build-and-read for JSValue handles', () => {
    test('build an array in-guest: js_array + js_push + js_from_int → a real JS array', async () => {
        const ex = await inst(compileBin(`\\\\ make_pair (Int, Int) -> JSValue
@fn make_pair a, b := {
    \\\\ arr JSValue
    @mut arr := js::array();
    js::push(arr, js::from_int(a));
    js::push(arr, js::from_int(b));
    arr
};
@export make_pair;`))
        const r = ex.make_pair(3, 4)
        expect(Array.isArray(r)).toBe(true)
        expect(r).toEqual([3, 4])
    })

    test('build an object in-guest: js_object + js_set + js_from_int → a real JS object', async () => {
        const ex = await inst(compileBin(`\\\\ make_obj (JSString, Int) -> JSValue
@fn make_obj key, val := {
    \\\\ o JSValue
    @mut o := js::object();
    js::set(o, key, js::from_int(val));
    o
};
@export make_obj;`))
        expect(ex.make_obj('count', 5)).toEqual({ count: 5 })
    })

    test('inspect a host object handed in: js_get + js_as_int', async () => {
        const ex = await inst(compileBin(`\\\\ read_field (JSValue, JSString) -> Int
@fn read_field obj, key := { js::as_int(js::get(obj, key)) };
@export read_field;`))
        expect(ex.read_field({ x: 99, y: 1 }, 'x')).toBe(99)
        expect(ex.read_field({ x: 99, y: 1 }, 'y')).toBe(1)
    })

    test('read an array element + length: js_get_index, js_len', async () => {
        const ex = await inst(compileBin(`\\\\ at (JSValue, Int) -> Int
@fn at arr, i := { js::as_int(js::get_index(arr, i)) };
\\\\ count (JSValue) -> Int
@fn count arr := { js::len(arr) };
@export at;
@export count;`))
        expect(ex.at([10, 20, 30], 1)).toBe(20)
        expect(ex.count([10, 20, 30])).toBe(3)
    })

    test('box/unbox round-trip preserves float and bool', async () => {
        const ex = await inst(compileBin(`\\\\ rt_float (Float) -> Float
@fn rt_float f := { js::as_float(js::from_float(f)) };
\\\\ rt_bool (Bool) -> Bool
@fn rt_bool b := { js::as_bool(js::from_bool(b)) };
@export rt_float;
@export rt_bool;`))
        expect(ex.rt_float(2.5)).toBeCloseTo(2.5)
        expect(ex.rt_bool(1)).toBe(1)
        expect(ex.rt_bool(0)).toBe(0)
    })

    test('js_is_null distinguishes a present field from a missing one', async () => {
        const ex = await inst(compileBin(`\\\\ missing (JSValue, JSString) -> Bool
@fn missing obj, key := { js::is_null(js::get(obj, key)) };
@export missing;`))
        expect(ex.missing({ a: 1 }, 'a')).toBe(0)   // present
        expect(ex.missing({ a: 1 }, 'zzz')).toBe(1) // absent → null
    })

    test('reflection: js_typeof / js_keys / js_has / js_null parse and run', async () => {
        const ex = await inst(compileBin(`\\\\ kind (JSValue) -> JSString
@fn kind v := { js::typeof(v) };
\\\\ has_key (JSValue, JSString) -> Bool
@fn has_key o, k := { js::has(o, k) };
\\\\ num_keys (JSValue) -> Int
@fn num_keys o := { js::len(js::keys(o)) };
\\\\ null_is_null () -> Bool
@fn null_is_null := { js::is_null(js::null()) };
@export kind;
@export has_key;
@export num_keys;
@export null_is_null;`))
        expect(ex.kind([1, 2])).toBe('array')
        expect(ex.kind({})).toBe('object')
        expect(ex.has_key({ a: 1 }, 'a')).toBe(1)
        expect(ex.has_key({ a: 1 }, 'b')).toBe(0)
        expect(ex.num_keys({ a: 1, b: 2, c: 3 })).toBe(3)
        expect(ex.null_is_null()).toBe(1)
    })

    test('INTEGRATION: build an options bag in-guest, hand it to the real json::stringify', async () => {
        // The core win of #1: construct an arbitrary object in guest code and pass
        // it to a real host API that takes a JSValue (here JSON.stringify).
        const ex = await inst(
            compileBin(`\\\\ build_and_stringify (JSString, JSString) -> JSString
@fn build_and_stringify k1, k2 := {
    \\\\ o JSValue
    @mut o := js::object();
    js::set(o, k1, js::from_int(1));
    js::set(o, k2, js::from_bool(@true));
    json::stringify(o)
};
@export build_and_stringify;`),
            { json: { parse: (t: any) => JSON.parse(t), stringify: (v: any) => JSON.stringify(v) } },
        )
        expect(ex.build_and_stringify('a', 'ok')).toBe('{"a":1,"ok":true}')
    })
})
