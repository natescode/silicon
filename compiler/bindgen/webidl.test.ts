// SPDX-License-Identifier: MIT
/**
 * ADR 0017 — the Web IDL adapter parses genuine upstream IDL into BindingSpecs.
 *
 * Proves the generator is Web-IDL-driven for Web IDL sources (not hand-seeded):
 * the real `Performance` interface text → `performance_now () -> Float`, the
 * exact spec the composed surface ships, with typedef resolution and the
 * double→Float (f32) type map.  `Math.*`/`Date.*` are ECMAScript, not Web IDL,
 * so they are correctly NOT sourced here (the per-source-adapter design).
 */

import { test, expect, describe } from 'bun:test'
import { webidlToSpecs } from './src/adapters/webidl'
import { PERFORMANCE_IDL, WEB_MATH_CLOCK } from './src/spec'

describe('bindgen — Web IDL adapter (webidl2)', () => {
    test('the real Performance IDL generates performance_now () -> Float', () => {
        const specs = webidlToSpecs(PERFORMANCE_IDL, {
            interfaceName: 'Performance', prefix: 'performance', accessor: 'performance',
        })
        expect(specs).toEqual([
            {
                name: 'performance_now',
                params: [],
                result: 'Float',                      // DOMHighResTimeStamp → double → Float (f32)
                impl: { kind: 'call', expr: 'performance.now()' },
                source: 'webidl:Performance.now',
            },
        ])
    })

    test('typedefs are resolved (DOMHighResTimeStamp → double → Float)', () => {
        const idl = `typedef double DOMHighResTimeStamp;
        interface I { DOMHighResTimeStamp t(); };`
        const [s] = webidlToSpecs(idl, { interfaceName: 'I', prefix: 'i', accessor: 'i' })
        expect(s.result).toBe('Float')
    })

    test('the WebIDL type map covers the Tier-0 numerics and rejects non-Tier-0', () => {
        const ok = `interface I {
            unsigned long u();
            long long ll();
            boolean b();
            DOMString s();
            undefined v();
        };`
        const specs = webidlToSpecs(ok, { interfaceName: 'I', prefix: 'i', accessor: 'i' })
        expect(specs.map(s => s.result)).toEqual(['Int', 'Int64', 'Bool', 'String', 'Void'])
        // A non-Tier-0 type (an interface handle / `any`) is rejected — it would
        // be Tier-1+ (an object handle, out of this slice's scope).
        const bad = `interface I { Element e(); };`
        expect(() => webidlToSpecs(bad, { interfaceName: 'I', prefix: 'i', accessor: 'i' }))
            .toThrow(/unmapped IDL type/)
    })

    test('the adapter output is exactly what the composed surface ships for Performance', () => {
        // The WebIDL-derived entry must be byte-identical to the one in the
        // generated surface — i.e. the generator really is Web-IDL-driven there.
        const fromAdapter = webidlToSpecs(PERFORMANCE_IDL, {
            interfaceName: 'Performance', prefix: 'performance', accessor: 'performance',
        })[0]
        const inSurface = WEB_MATH_CLOCK.find(s => s.name === 'performance_now')
        expect(inSurface).toEqual(fromAdapter)
        // …and Math/Date are sourced from ECMAScript, not Web IDL.
        expect(WEB_MATH_CLOCK.find(s => s.name === 'math_sin')!.source).toBe('ecmascript:Math.sin')
        expect(WEB_MATH_CLOCK.find(s => s.name === 'date_now')!.source).toBe('ecmascript:Date.now')
    })
})
