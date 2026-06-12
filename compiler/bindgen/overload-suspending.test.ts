// SPDX-License-Identifier: MIT
/**
 * Next FFI work #5 — generator harvest improvements:
 *   1. dts overload selection — pick the BEST bindable overload, not blindly the
 *      first, recovering members whose first overload is unrepresentable
 *      (Bun.spawn / write / file) and preferring concrete params over handles.
 *   2. webiface `@suspending` — a `Promise<T>`-returning IDL operation becomes a
 *      suspending binding whose result is the awaited T (Response.json / text).
 */
import { describe, test, expect } from 'bun:test'
import { dtsToSpecs } from './src/adapters/dts'
import { webifaceToSpecs } from './src/adapters/webiface'

describe('dts overload selection (#5)', () => {
    const bun = () => dtsToSpecs({ global: 'Bun', types: ['bun-types'], accessor: 'Bun', prefix: '', objects: 'jsvalue', async: 'suspending' }).specs

    test('recovers members whose first overload was unrepresentable', () => {
        const names = new Set(bun().map(s => s.name))
        // These bind only via a non-first overload — blind sigs[0] dropped them.
        expect(names.has('spawn')).toBe(true)
        expect(names.has('spawn_sync')).toBe(true)
        expect(names.has('write')).toBe(true)
    })

    test('prefers the overload with the most concrete (non-handle) params', () => {
        // A 2-arg variant of a member is chosen over a 1-arg one when it binds more
        // concretely.  os.setPriority(pid, priority) — both Float — is the full form.
        const os = dtsToSpecs({ module: 'node:os', types: ['node'], accessor: "require('node:os')", prefix: '' }).specs
        const sp = os.find(s => s.name === 'set_priority')
        expect(sp?.params.length).toBe(2)
    })
})

describe('webiface @suspending Promise operations (#5)', () => {
    const response = () => webifaceToSpecs('Response').specs

    test('Response body readers (json/text/arrayBuffer) become @suspending', () => {
        const specs = response()
        const json = specs.find(s => s.name === 'json')
        const text = specs.find(s => s.name === 'text')
        expect(json?.suspending).toBe(true)
        expect(text?.suspending).toBe(true)
        // json resolves to an opaque value handle; text to a string.
        expect(json?.result).toBe('JSValue')
        expect(text?.result).toBe('String')
    })

    test('a sync accessor (status) is NOT marked suspending', () => {
        const status = response().find(s => s.name === 'status')
        expect(status?.suspending).toBeFalsy()
        expect(status?.result).toBe('Int')
    })
})
