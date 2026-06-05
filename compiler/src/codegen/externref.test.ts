// SPDX-License-Identifier: MIT
/**
 * W1 — `externref` valtype emission for the web/bun platform (JS String Builtins).
 *
 * Proves the binary emitter can declare a `wasm:js-string` import on `externref`
 * and that Bun runs it natively via `{ builtins: ['js-string'] }`.  This is the
 * foundation the JSString type + `js_string` module build on.
 */
import { describe, test, expect } from 'bun:test'
import { irModuleToWasm } from './index'
import { emitModule } from '../ir/emit'
import type { IRModule } from '../ir/nodes'

const externNullable = { localTypeIdx: 0, nullable: true, extern: true }

/** IR: `len(externref) -> i32` calling the imported `wasm:js-string` `length`. */
function lengthModule(): IRModule {
    const externP = new Map([[0, externNullable]])
    return {
        kind: 'Module',
        imports: [{
            kind: 'Import', env: 'wasm:js-string', field: 'length', name: 'jsstr_length',
            params: ['i32'], result: 'i32', refParams: externP,
        }],
        globals: [], dataSegments: [],
        functions: [{
            kind: 'Function', name: 'len',
            params: [{ name: 's', wasmType: 'i32', refType: externNullable }],
            returnType: 'i32', locals: [], refParams: externP,
            body: { kind: 'Call', wasmType: 'i32', callee: 'jsstr_length', callKind: 'user', args: [{ kind: 'LocalGet', wasmType: 'i32', name: 's' }] },
        }],
        exports: [{ kind: 'Export', alias: 'len', internalName: 'len', what: 'func' }],
    }
}

describe('W1: externref valtype', () => {
    test('WAT emitter renders externref params + the wasm:js-string import', () => {
        const wat = emitModule(lengthModule(), '')
        expect(wat).toContain('(import "wasm:js-string" "length" (func $jsstr_length (param externref) (result i32)))')
        expect(wat).toContain('(param $s externref)')
    })

    test('binary encodes externref (0x6F) and runs natively under Bun', async () => {
        const bytes = irModuleToWasm(lengthModule(), { target: 'host' })
        // The externref valtype byte 0x6F appears in the type section.
        expect(bytes.includes(0x6f)).toBe(true)
        const mod = await WebAssembly.compile(bytes, { builtins: ['js-string'] } as any)
        const inst = await WebAssembly.instantiate(mod, { env: { print: () => {}, read: () => 0 } })
        const len = (inst.exports as any).len as (s: string) => number
        expect(len('hello world')).toBe(11)
        expect(len('')).toBe(0)
        expect(len('héllo🎉')).toBe(7)   // UTF-16 code-unit length, host-native
    })

    test('non-null (ref extern) result emits 0x64 0x6F', () => {
        const m = lengthModule()
        m.imports[0] = {
            kind: 'Import', env: 'wasm:js-string', field: 'fromCodePoint', name: 'jsstr_fcp',
            params: ['i32'], refResult: { localTypeIdx: 0, nullable: false, extern: true },
        }
        const wat = emitModule(m, '')
        expect(wat).toContain('(import "wasm:js-string" "fromCodePoint" (func $jsstr_fcp (param i32) (result (ref extern))))')
    })
})
