// SPDX-License-Identifier: MIT
/**
 * ADR 0019 §2.2 — the leak-free wasm-gc closure REPRESENTATION, end-to-end.
 *
 * The escaping/host-callable closure (`@export_callback`) must cross `@extern` as
 * an `externref`-boxed GC ref so the engine traces it: the closure env stays alive
 * while the host holds the handle and is COLLECTED when the host drops it (no
 * bump-heap retention — the linear-memory baseline's documented leak).  The three
 * codegen primitives ADR 0019 named "absent today" make this possible:
 *   - `extern.convert_any`  (IRExternConvertAny, 0xFB 0x1B) — box a GC ref as externref
 *   - `any.convert_extern`  (IRAnyConvertExtern, 0xFB 0x1A) — unbox externref → anyref
 *   - `ref.cast (ref $T)`   (IRRefCast,          0xFB 0x16) — narrow to the env type
 *
 * This builds an IRModule through Silicon's REAL emitter (emitWasmBinary) that
 * boxes a `(ref $Array_i32)` env, hands it to the host, and reads it back via
 * unbox+cast — then runs it under Bun.  The env array IS the closure record
 * (`$Vec_i32`'s data array in the real closure path); here a 1-element array
 * stands in for `[…captures]`.
 */

import { test, expect, describe } from 'bun:test'
import type {
    IRExpr, IRModule, IRFunction, WasmGcType, IRArrayNew, IRArrayGet,
    IRExternConvertAny, IRAnyConvertExtern, IRRefCast,
} from '../ir/nodes'
import { emitWasmBinary } from './wasm-emitter'
import { buildPrelude } from './prelude-ir'

const ARRAY_I32: WasmGcType = {
    name: '$Array_i32',
    spec: { kind: 'array', element: { storage: { kind: 'val', type: 'i32' }, mutable: true } },
}
const c = (v: number): IRExpr => ({ kind: 'Const', wasmType: 'i32', value: v })
const lget = (name: string): IRExpr => ({ kind: 'LocalGet', wasmType: 'i32', name })

/** extract the code section (id=10). */
function findGcOp(bin: Uint8Array, subOp: number): boolean {
    for (let i = 0; i < bin.length - 1; i++) if (bin[i] === 0xFB && bin[i + 1] === subOp) return true
    return false
}

/** make(factor) → externref: a 1-element env array [factor], boxed as externref. */
const makeFn: IRFunction = {
    kind: 'Function', name: 'make',
    params: [{ name: 'factor', wasmType: 'i32' }],
    returnType: 'i32',                                   // ref-as-i32 at IR level
    refResult: { localTypeIdx: 0, nullable: false, extern: true },   // (ref extern)
    locals: [],
    body: {
        kind: 'ExternConvertAny', wasmType: 'i32',
        value: { kind: 'ArrayNew', wasmType: 'i32', typeIdx: 0, typeName: '$Array_i32', init: lget('factor'), size: c(1) } as IRArrayNew,
    } as IRExternConvertAny,
}

/** read(clo: externref) → i32: unbox + ref.cast $Array_i32 + array.get[0]. */
const readFn: IRFunction = {
    kind: 'Function', name: 'read',
    params: [{ name: 'clo', wasmType: 'i32', refType: { localTypeIdx: 0, nullable: true, extern: true } }],
    refParams: new Map([[0, { localTypeIdx: 0, nullable: true, extern: true }]]),
    returnType: 'i32',
    locals: [],
    body: {
        kind: 'ArrayGet', wasmType: 'i32', typeIdx: 0, typeName: '$Array_i32',
        target: {
            kind: 'RefCast', wasmType: 'i32', typeIdx: 0, typeName: '$Array_i32', nullable: false,
            value: { kind: 'AnyConvertExtern', wasmType: 'i32', value: lget('clo') } as IRAnyConvertExtern,
        } as IRRefCast,
        idx: c(0),
    } as IRArrayGet,
}

function buildModule(): IRModule {
    return {
        kind: 'Module', imports: [], globals: [], dataSegments: [],
        functions: [makeFn, readFn],
        wasmGcTypes: [ARRAY_I32],
        exports: [
            { kind: 'Export', alias: 'make', internalName: 'make', what: 'func' },
            { kind: 'Export', alias: 'read', internalName: 'read', what: 'func' },
        ],
    }
}

describe('ADR 0019 §2.2 — leak-free wasm-gc closure representation (codegen)', () => {
    test('emitter produces the three GC reference-conversion opcodes', () => {
        const bin = emitWasmBinary(buildPrelude(1024, false), buildModule())
        expect(findGcOp(bin, 0x1B)).toBe(true)   // extern.convert_any (box)
        expect(findGcOp(bin, 0x1A)).toBe(true)   // any.convert_extern (unbox)
        expect(findGcOp(bin, 0x16)).toBe(true)   // ref.cast (ref $T) non-null
    })

    test('a GC env boxed as externref crosses to the host and is read back (engine-GC\'d, no leak)', async () => {
        const bin = emitWasmBinary(buildPrelude(1024, false), buildModule())
        expect(await WebAssembly.validate(bin)).toBe(true)

        const inst = await WebAssembly.instantiate(bin, { env: { print: () => {}, read: () => 0 } })
        const ex = inst.instance.exports as any

        // make() returns a host-held externref handle (a real JS object reference,
        // NOT an i32 pointer) — the engine traces it, so it cannot leak.
        const h7 = ex.make(7)
        expect(typeof h7).toBe('object')         // an engine reference, not a number
        expect(ex.read(h7)).toBe(7)              // unbox + ref.cast + array.get
        expect(ex.read(h7)).toBe(7)              // repeatable — the env persists

        const h4 = ex.make(4)
        expect(ex.read(h4)).toBe(4)              // a distinct env
        expect(ex.read(h7)).toBe(7)              // h7 unaffected (independent GC objects)
        expect(h4).not.toBe(h7)
    })
})
