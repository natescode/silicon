// SPDX-License-Identifier: MIT
/**
 * ADR 0017 — every FFI source adapter is spec-driven (not hand-authored).
 *
 * These tests run the adapters against the REAL installed spec sources and
 * assert they auto-generate the expected BindingSpecs:
 *   - Web   → @webref/idl   (the genuine Web platform IDL corpus, via webidl2)
 *   - Node  → @types/node   (real .d.ts via the TypeScript compiler API)
 *   - Bun   → bun-types     (real .d.ts via the TypeScript compiler API)
 * The only non-spec source is ECMAScript (`Math`/`Date`) — built-ins with no
 * machine-readable IDL — which is the hand-authored table in spec.ts.
 */

import { test, expect, describe } from 'bun:test'
import { webrefToSpecs } from './src/adapters/webref'
import { dtsToSpecs } from './src/adapters/dts'
import { webifaceToSpecs } from './src/adapters/webiface'

describe('bindgen adapters — generated from real spec sources', () => {
    test('Web: @webref/idl corpus → Tier-0 bindings with WebIDL signatures', () => {
        const { specs, skipped } = webrefToSpecs()
        const byName = new Map(specs.map(s => [s.name, s]))
        // performance_now from the real hr-time.idl, double → Float.
        expect(byName.get('performance_now')).toEqual({
            name: 'performance_now', params: [], result: 'Float',
            impl: { kind: 'call', expr: 'performance.now()' }, source: 'webref:Performance.now',
        })
        // crypto.randomUUID(): DOMString → String, from the real crypto IDL.
        expect(byName.get('crypto_random_uuid')?.result).toBe('String')
        // A param'd Web IDL op typed correctly (window.confirm(DOMString) → boolean).
        expect(byName.get('window_confirm')).toMatchObject({ params: [{ type: 'String' }], result: 'Bool' })
        // Non-Tier-0 ops (sequences / objects) are skipped + logged, never dropped.
        expect(skipped.some(s => s.member === 'Performance.getEntries')).toBe(true)
        expect(specs.length).toBeGreaterThan(10)
    })

    test('Node: @types/node path module → Tier-0 bindings via the TS checker', () => {
        const { specs, skipped } = dtsToSpecs({
            module: 'node:path', types: ['node'], accessor: "require('node:path')", prefix: 'path',
        })
        const byName = new Map(specs.map(s => [s.name, s]))
        // basename(string, string) -> string — resolved through the real .d.ts.
        expect(byName.get('path_basename')).toMatchObject({
            params: [{ type: 'String' }, { type: 'String' }], result: 'String',
        })
        // isAbsolute(string) -> boolean; an alias/union return still resolves.
        expect(byName.get('path_is_absolute')?.result).toBe('Bool')
        // join(...paths: string[]) is a sequence → skipped (not Tier-0).
        expect(skipped.some(s => s.member === 'path.join')).toBe(true)
        expect(byName.get('path_basename')!.impl).toEqual({ kind: 'call', expr: "require('node:path').basename(path, suffix)" })
    })

    test('Bun: bun-types global Bun namespace → Tier-0 bindings via the TS checker', () => {
        const { specs } = dtsToSpecs({ global: 'Bun', types: ['bun-types'], accessor: 'Bun', prefix: 'bun' })
        const byName = new Map(specs.map(s => [s.name, s]))
        // Bun.nanoseconds(): number → Float (the number heuristic).
        expect(byName.get('bun_nanoseconds')).toMatchObject({ params: [], result: 'Float' })
        expect(byName.get('bun_nanoseconds')!.impl).toEqual({ kind: 'call', expr: 'Bun.nanoseconds()' })
        // Bun.stripANSI(string) -> string (snake-cased name).
        expect(byName.get('bun_strip_ansi')?.result).toBe('String')
        expect(specs.length).toBeGreaterThan(0)
    })

    test('Tier-2: objects: "jsvalue" maps object types to the JSValue handle (JSON.parse/stringify)', () => {
        // In 'skip' mode JSON is invisible (object result/param).  In 'jsvalue'
        // mode the object types become the externref handle JSValue, and the
        // unrepresentable optional `reviver`/`replacer` callbacks are dropped.
        const skip = dtsToSpecs({ global: 'JSON', types: [], accessor: 'JSON', prefix: '', objects: 'skip' })
        expect(skip.specs.length).toBe(0)
        expect(skip.skipped.some(s => s.member === 'JSON.parse')).toBe(true)

        const { specs } = dtsToSpecs({ global: 'JSON', types: [], accessor: 'JSON', prefix: '', objects: 'jsvalue' })
        const byName = new Map(specs.map(s => [s.name, s]))
        // parse(text: string, reviver?: fn) -> any  ⇒  (String) -> JSValue  (reviver dropped).
        expect(byName.get('parse')).toMatchObject({ params: [{ type: 'String' }], result: 'JSValue' })
        // stringify(value: any, replacer?, space?) -> string  ⇒  (JSValue) -> String  (trailing optionals dropped).
        expect(byName.get('stringify')).toMatchObject({ params: [{ type: 'JSValue' }], result: 'String' })
        expect(byName.get('stringify')!.impl).toEqual({ kind: 'call', expr: 'JSON.stringify(value)' })
    })

    test('jsvalue mode: generic constraints, bigint, unknown, and sync-arm-of-Promise unions cross as JSValue', () => {
        // node:crypto exercises the generic-param + bigint-union recoveries.
        const crypto = dtsToSpecs({
            module: 'node:crypto', types: ['node'], accessor: "require('node:crypto')",
            prefix: '', objects: 'jsvalue', numberType: 'Int', events: 'closure',
        })
        const c = new Map(crypto.specs.map(s => [s.name, s]))
        // randomFillSync<T extends ArrayBufferView>(buffer: T, …): T — an unconstrained-
        // shaped generic result resolves to a JSValue handle (and the buffer param too).
        expect(c.get('random_fill_sync')).toMatchObject({ params: [{ type: 'JSValue' }, { type: 'Int' }, { type: 'Int' }], result: 'JSValue' })
        // getRandomValues<T extends ArrayBufferView>(array: T): T — generic param→constraint→JSValue.
        expect(c.get('get_random_values')).toMatchObject({ params: [{ type: 'JSValue' }], result: 'JSValue' })
        // generateKeyPairSync(type, options): the `options` generic resolves to its
        // object constraint → JSValue (not skipped).
        expect(c.get('generate_key_pair_sync')?.params.at(-1)).toMatchObject({ type: 'JSValue' })
        // checkPrimeSync(candidate: LargeNumberLike): the bigint arm of the union no
        // longer poisons the whole union — it binds as a JSValue handle.
        expect(c.get('check_prime_sync')).toBeDefined()
        expect(crypto.skipped.some(s => s.member.endsWith('.checkPrimeSync'))).toBe(false)

        // Bun: `unknown` params and `T | Promise<T>` unions cross via their sync arm.
        const bun = dtsToSpecs({ global: 'Bun', types: ['bun-types'], accessor: 'Bun', prefix: '', objects: 'jsvalue', async: 'suspending' })
        const b = new Map(bun.specs.map(s => [s.name, s]))
        // deepMatch(subset: unknown, a: unknown) — unknown → JSValue (was a non-Tier-0 skip).
        expect(b.get('deep_match')).toMatchObject({ params: [{ type: 'JSValue' }, { type: 'JSValue' }], result: 'Bool' })
        // peek<T>(promise): T | Promise<T> — the Promise arm is dropped, the sync arm binds.
        expect(b.get('peek')).toMatchObject({ result: 'JSValue' })
        expect(bun.skipped.some(s => s.member === 'Bun.peek')).toBe(false)
    })

    test('a rest param (`...args`) stays skipped in portable mode, binds via spread in jsvalue mode', () => {
        // SKIP mode (a portable Tier-0 module like the shipped `path`): a variadic
        // can't degrade to a meaningless `join()`, and its array must NOT be
        // smuggled as one linear arg (`join([a,b])` ≠ `join(a,b)`) — so it stays
        // skipped, keeping the module portable to any host.
        const portable = dtsToSpecs({
            module: 'node:path', types: ['node'], accessor: "require('node:path')", prefix: 'path',
        })
        expect(portable.specs.some(s => s.name === 'path_join')).toBe(false)
        expect(portable.skipped.some(s => s.member === 'path.join')).toBe(true)

        // JSVALUE mode (Tier-2, web/bun): the variadic binds as ONE trailing JSValue
        // array handle the host spreads — `require('node:path').join(...paths)`.
        const handles = dtsToSpecs({
            module: 'node:path', types: ['node'], accessor: "require('node:path')", prefix: 'path', objects: 'jsvalue',
        })
        const join = handles.specs.find(s => s.name === 'path_join')
        expect(join).toMatchObject({ params: [{ type: 'JSValue' }], impl: { kind: 'spread', method: 'join' } })
        expect(handles.skipped.some(s => s.member === 'path.join')).toBe(false)
    })

    test('a tagged-template function (Bun.$) is skipped — not a normal callable; no invalid name leaks', () => {
        // `Bun.$` is a tagged template (first param TemplateStringsArray); calling it
        // as a normal fn throws.  It is skipped (a JS syntactic form, not a binding),
        // and no spec is named with the invalid identifier `$`.
        const bun = dtsToSpecs({ global: 'Bun', types: ['bun-types'], accessor: 'Bun', prefix: '', objects: 'jsvalue', async: 'suspending' })
        expect(bun.skipped.some(s => s.member === 'Bun.$' && /tagged-template/.test(s.reason))).toBe(true)
        expect(bun.specs.some(s => s.name === '$' || s.name === 'shell')).toBe(false)
        // Every emitted name is a valid Silicon identifier (the sanitize safeguard).
        for (const s of bun.specs) expect(s.name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/)
    })

    test('intersection + conditional types cross as JSValue handles (Bun.serve / Bun.plugin)', () => {
        // Bun.serve's `options` is an intersection; Bun.plugin's result is a
        // conditional type (ReturnType<T["setup"]>) — both opaque at the boundary.
        const bun = dtsToSpecs({ global: 'Bun', types: ['bun-types'], accessor: 'Bun', prefix: '', objects: 'jsvalue', async: 'suspending' })
        expect(bun.specs.find(s => s.name === 'serve')).toMatchObject({ params: [{ type: 'JSValue' }] })
        expect(bun.specs.find(s => s.name === 'plugin')).toMatchObject({ result: 'JSValue' })
        // The ONLY remaining bun skip is the tagged-template `$` (no classifier gap).
        expect(bun.skipped.map(s => s.member)).toEqual(['Bun.$'])
    })

    test('the number heuristic is configurable per namespace (TS `number` is opaque)', () => {
        // Default Float; flip to Int where an API is integer-valued.
        const asFloat = dtsToSpecs({ global: 'Bun', types: ['bun-types'], accessor: 'Bun', prefix: 'bun' })
        const asInt = dtsToSpecs({ global: 'Bun', types: ['bun-types'], accessor: 'Bun', prefix: 'bun', numberType: 'Int' })
        expect(asFloat.specs.find(s => s.name === 'bun_nanoseconds')?.result).toBe('Float')
        expect(asInt.specs.find(s => s.name === 'bun_nanoseconds')?.result).toBe('Int')
    })
})

describe('bindgen webiface adapter — constructed Web interfaces from @webref/idl', () => {
    const byName = (specs: { name: string }[]) => new Map(specs.map(s => [s.name, s as any]))

    test('URL: constructor → create, getter/setter pairs, static, stringifier → to_string', () => {
        const { specs } = webifaceToSpecs('URL')
        const m = byName(specs)
        // constructor binds as `create` (`new` is a reserved Silicon token); the
        // optional `base` is DROPPED (a secondary optional after the required url),
        // so the 1-arg form is exposed.
        expect(m.get('create')).toMatchObject({
            params: [{ type: 'String' }], result: 'JSValue', impl: { kind: 'construct', iface: 'URL' },
        })
        // a static with only a required arg keeps it; its trailing optional base is dropped.
        expect(m.get('can_parse')).toMatchObject({ params: [{ type: 'String' }], result: 'Bool' })
        // writable attribute → getter + setter; the receiver is a JSValue handle.
        expect(m.get('href')).toMatchObject({ params: [{ name: 'self', type: 'JSValue' }], result: 'String', impl: { kind: 'getter', attr: 'href' } })
        expect(m.get('set_href')).toMatchObject({ params: [{ type: 'JSValue' }, { type: 'String' }], result: 'Void', impl: { kind: 'setter', attr: 'href' } })
        // readonly attribute → getter only.
        expect(m.get('origin')?.impl).toEqual({ kind: 'getter', attr: 'origin' })
        expect(m.get('set_origin')).toBeUndefined()
        // a static method takes NO receiver and reaches through the interface global.
        expect(m.get('can_parse')).toMatchObject({ result: 'Bool', impl: { kind: 'static', iface: 'URL', method: 'canParse' } })
        // an interface-typed attribute crosses as a JSValue handle (the cross-handle case).
        expect(m.get('search_params')).toMatchObject({ result: 'JSValue', impl: { kind: 'getter', attr: 'searchParams' } })
        // the stringifier (URL's is the href attribute) also yields to_string → obj.toString().
        expect(m.get('to_string')).toMatchObject({ params: [{ type: 'JSValue' }], result: 'String', impl: { kind: 'method', method: 'toString' } })
    })

    test('TextEncoder/TextDecoder: object members cross as JSValue handles (Uint8Array / BufferSource)', () => {
        const enc = byName(webifaceToSpecs('TextEncoder').specs)
        // encode returns a Uint8Array (ambient buffer type) → JSValue handle; input kept.
        expect(enc.get('encode')).toMatchObject({ params: [{ type: 'JSValue' }, { type: 'String' }], result: 'JSValue', impl: { kind: 'method', method: 'encode' } })
        const dec = byName(webifaceToSpecs('TextDecoder').specs)
        // decode takes a BufferSource handle (JSValue) and returns a String.
        expect(dec.get('decode')).toMatchObject({ params: [{ type: 'JSValue' }, { type: 'JSValue' }], result: 'String', impl: { kind: 'method', method: 'decode' } })
    })

    test('dictionaries / sequences cross as JSValue handles (the guest drives them via the js module)', () => {
        // TextEncoder.encodeInto returns a dictionary (TextEncoderEncodeIntoResult) →
        // a JSValue handle (the guest reads {read, written} with js::get); the
        // destination buffer is also a JSValue handle.
        const enc = byName(webifaceToSpecs('TextEncoder').specs)
        expect(enc.get('encode_into')).toMatchObject({
            params: [{ type: 'JSValue' }, { type: 'String' }, { type: 'JSValue' }], result: 'JSValue',
            impl: { kind: 'method', method: 'encodeInto' },
        })
        // Headers.getSetCookie returns a sequence<ByteString> → a JSValue array handle
        // (the guest walks it with js::len / js::get_index).
        const h = webifaceToSpecs('Headers')
        expect(byName(h.specs).get('get_set_cookie')).toMatchObject({ params: [{ type: 'JSValue' }], result: 'JSValue' })
        // Headers ctor's union init has no string arm and is optional → dropped → create() no-arg.
        expect(byName(h.specs).get('create')).toMatchObject({ params: [], result: 'JSValue' })
        // A genuine callback attribute (an EventHandler) still skips — webiface has no
        // closure-trampoline path, so it is the documented fundamental tail.
        expect(webifaceToSpecs('AbortSignal').skipped.some(s => s.member === 'onabort')).toBe(true)
    })

    test('URLSearchParams: a union ctor arg with a string member is bindable as String', () => {
        // init is (sequence<…> or record<…> or USVString) — the USVString arm means
        // the guest can supply a query string, so it binds as a String param.
        const m = byName(webifaceToSpecs('URLSearchParams').specs)
        expect(m.get('create')).toMatchObject({ params: [{ type: 'String' }], result: 'JSValue' })
        // its anonymous operation-stringifier also yields to_string.
        expect(m.get('to_string')?.impl).toEqual({ kind: 'method', method: 'toString' })
    })

    test('optional-arg policy: secondary optionals dropped (no silent-wrong answers); payload optionals kept', () => {
        // has/delete drop the optional `value` → the 1-arg WHATWG membership/clear
        // forms (forcing `value=""` would silently mis-answer; Silicon has no
        // optional params and "" ≠ omitted).
        const usp = byName(webifaceToSpecs('URLSearchParams').specs)
        expect(usp.get('has')).toMatchObject({ params: [{ type: 'JSValue' }, { type: 'String' }], result: 'Bool' })
        expect(usp.get('delete')).toMatchObject({ params: [{ type: 'JSValue' }, { type: 'String' }] })
        // But a payload optional with no required arg before it is KEPT (else the op
        // is useless): TextEncoder.encode(input?) and new URLSearchParams(init?).
        const enc = byName(webifaceToSpecs('TextEncoder').specs)
        expect(enc.get('encode')).toMatchObject({ params: [{ type: 'JSValue' }, { type: 'String' }] })
        expect(usp.get('create')?.params).toHaveLength(1)
        // URL.canParse/create drop the trailing optional base → 1-arg.
        const url = byName(webifaceToSpecs('URL').specs)
        expect(url.get('create')?.params).toHaveLength(1)
        expect(url.get('can_parse')?.params).toHaveLength(1)
    })

    test('a static factory colliding with an instance member is disambiguated, not dropped (Response.json)', () => {
        // Response has BOTH an instance Body-mixin `json()` body-reader (suspending)
        // and a static `json(data)` factory.  @extern has no overloading, so the
        // instance reader keeps `json` and the static ships as `json_static`.
        const m = byName(webifaceToSpecs('Response').specs)
        expect(m.get('json')).toMatchObject({ params: [{ type: 'JSValue' }], suspending: true, impl: { kind: 'method', method: 'json' } })
        expect(m.get('json_static')).toMatchObject({ impl: { kind: 'static', iface: 'Response', method: 'json' } })
        expect(webifaceToSpecs('Response').skipped.some(s => s.member === 'json')).toBe(false)
    })

    test("events:'closure': an EventHandler attribute binds as a setter-only Callback (default skip preserved)", () => {
        // DEFAULT ('skip') leaves onabort unbindable — the prior behaviour the
        // lockfile/other callers depend on.
        const skip = webifaceToSpecs('AbortSignal')
        expect(skip.skipped.some(s => s.member === 'onabort')).toBe(true)
        expect(byName(skip.specs).has('set_onabort')).toBe(false)

        // 'closure' binds `signal.onabort = handler` as a Callback SETTER — and
        // emits NO getter (a host handler can't be handed back to the guest).
        const clo = webifaceToSpecs('AbortSignal', undefined, 'closure')
        const m = byName(clo.specs)
        expect(clo.skipped.some(s => s.member === 'onabort')).toBe(false)
        expect(m.get('set_onabort')).toMatchObject({
            params: [{ type: 'JSValue' }, { type: 'Callback' }], result: 'Void',
            impl: { kind: 'setter', attr: 'onabort' },
        })
        expect(m.has('onabort')).toBe(false)   // no getter
    })

    test("events:'closure': EventTarget binds add/removeEventListener with a Callback listener", () => {
        // 'skip' leaves the EventListener (a callback interface) arg unbindable, so
        // the whole member skips — only dispatchEvent (Event handle) survives.
        const skip = byName(webifaceToSpecs('EventTarget').specs)
        expect(skip.has('add_event_listener')).toBe(false)
        expect(skip.get('dispatch_event')).toBeDefined()

        // 'closure' binds the listener arg as a Callback; the optional `options`
        // union is dropped → the 2-arg (type, callback) form.  EventListener is a
        // `callback interface`, so this also proves callback-interface detection.
        const m = byName(webifaceToSpecs('EventTarget', undefined, 'closure').specs)
        expect(m.get('add_event_listener')).toMatchObject({
            params: [{ type: 'JSValue' }, { type: 'String' }, { type: 'Callback' }], result: 'Void',
            impl: { kind: 'method', method: 'addEventListener' },
        })
        expect(m.get('remove_event_listener')).toMatchObject({
            params: [{ type: 'JSValue' }, { type: 'String' }, { type: 'Callback' }],
        })
        // dispatchEvent still binds its Event arg as a plain JSValue handle — a
        // regular interface must NOT be mistaken for a callback.
        expect(m.get('dispatch_event')).toMatchObject({ params: [{ type: 'JSValue' }, { type: 'JSValue' }], result: 'Bool' })
    })
})
