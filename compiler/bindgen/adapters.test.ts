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

    test('a rest param (`...args`) is NOT dropped — its binding stays skipped (no silent no-arg call)', () => {
        // `path.join(...paths)` must not degrade to a meaningless `join()`: a rest
        // param is required-shaped, so the whole binding is skipped even in
        // jsvalue mode (only OPTIONAL `?` params are droppable).
        const { specs, skipped } = dtsToSpecs({
            module: 'node:path', types: ['node'], accessor: "require('node:path')", prefix: 'path', objects: 'jsvalue',
        })
        expect(specs.some(s => s.name === 'path_join')).toBe(false)
        expect(skipped.some(s => s.member === 'path.join')).toBe(true)
    })

    test('the number heuristic is configurable per namespace (TS `number` is opaque)', () => {
        // Default Float; flip to Int where an API is integer-valued.
        const asFloat = dtsToSpecs({ global: 'Bun', types: ['bun-types'], accessor: 'Bun', prefix: 'bun' })
        const asInt = dtsToSpecs({ global: 'Bun', types: ['bun-types'], accessor: 'Bun', prefix: 'bun', numberType: 'Int' })
        expect(asFloat.specs.find(s => s.name === 'bun_nanoseconds')?.result).toBe('Float')
        expect(asInt.specs.find(s => s.name === 'bun_nanoseconds')?.result).toBe('Int')
    })
})
