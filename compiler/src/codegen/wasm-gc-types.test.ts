// SPDX-License-Identifier: MIT
/**
 * Phase 9d-2 — WasmGC type-section emitter.
 *
 * Verifies the binary encoding of `(type $foo (struct …))` and
 * `(type $bar (array (mut …))) declarations in section 1 of the wasm
 * binary, the dedup logic in `WasmGcTypeRegistry`, and that emitted
 * modules pass `WebAssembly.compile` validation.
 *
 * Scope is the emitter contract from `wit/wasm-gc.wit` v1.0:
 *   - struct types (0x5F form)
 *   - array types (0x5E form)
 *   - value, packed (i8/i16), and ref-typed fields
 *   - mutability bit on each field
 *
 * Out of scope (v1.1 in `wit/wasm-gc.wit`):
 *   - `sub` / `sub final` wrappers
 *   - rec groups
 *   - ref.test / ref.cast (instruction-level, not type-section)
 */

import { test, expect, describe } from 'bun:test'
import {
    WasmGcTypeRegistry, wasmGcTypeKey,
    type WasmGcType, type IRModule,
} from '../ir/nodes'
import { emitWasmBinary } from './wasm-emitter'
import { buildPrelude } from './prelude-ir'

// ── helpers ─────────────────────────────────────────────────────────────

/** Locate the type section (id=1) in a wasm binary; return its body bytes. */
function extractTypeSection(bin: Uint8Array): Uint8Array {
    // Header: 8 bytes (magic + version).
    let p = 8
    while (p < bin.length) {
        const sectionId = bin[p]
        // ULEB128 size (single-byte for the modules we emit in tests).
        let size = 0
        let shift = 0
        let q = p + 1
        while (true) {
            const b = bin[q++]
            size |= (b & 0x7f) << shift
            if ((b & 0x80) === 0) break
            shift += 7
        }
        if (sectionId === 1) {
            return bin.slice(q, q + size)
        }
        p = q + size
    }
    throw new Error('type section (id=1) not found')
}

function emptyUserModule(): IRModule {
    return {
        kind: 'Module',
        imports: [],
        globals: [],
        functions: [],
        dataSegments: [],
        exports: [],
    }
}

// ── 1. WasmGcTypeRegistry — structural dedup ────────────────────────────

describe('WasmGcTypeRegistry dedup', () => {

    test('intern returns a fresh index for the first call', () => {
        const reg = new WasmGcTypeRegistry()
        const idx = reg.intern({
            name: '$Point',
            spec: { kind: 'struct', fields: [
                { storage: { kind: 'val', type: 'i32' }, mutable: true },
                { storage: { kind: 'val', type: 'i32' }, mutable: true },
            ]},
        })
        expect(idx).toBe(0)
        expect(reg.size()).toBe(1)
    })

    test('intern of structurally-identical types returns the same index', () => {
        const reg = new WasmGcTypeRegistry()
        const a: WasmGcType = {
            name: '$Point',
            spec: { kind: 'struct', fields: [
                { storage: { kind: 'val', type: 'i32' }, mutable: true },
                { storage: { kind: 'val', type: 'i32' }, mutable: true },
            ]},
        }
        const b: WasmGcType = {
            // different debug name, same structural layout
            name: '$Coord',
            spec: { kind: 'struct', fields: [
                { storage: { kind: 'val', type: 'i32' }, mutable: true },
                { storage: { kind: 'val', type: 'i32' }, mutable: true },
            ]},
        }
        expect(reg.intern(a)).toBe(0)
        expect(reg.intern(b)).toBe(0)
        expect(reg.size()).toBe(1)
    })

    test('intern of differently-typed fields gets a fresh index', () => {
        const reg = new WasmGcTypeRegistry()
        const intStruct: WasmGcType = {
            name: '$IntPair',
            spec: { kind: 'struct', fields: [
                { storage: { kind: 'val', type: 'i32' }, mutable: true },
                { storage: { kind: 'val', type: 'i32' }, mutable: true },
            ]},
        }
        const floatStruct: WasmGcType = {
            name: '$FloatPair',
            spec: { kind: 'struct', fields: [
                { storage: { kind: 'val', type: 'f32' }, mutable: true },
                { storage: { kind: 'val', type: 'f32' }, mutable: true },
            ]},
        }
        expect(reg.intern(intStruct)).toBe(0)
        expect(reg.intern(floatStruct)).toBe(1)
    })

    test('intern distinguishes mutability', () => {
        const reg = new WasmGcTypeRegistry()
        const mut: WasmGcType = {
            name: '$Mut',
            spec: { kind: 'struct', fields: [
                { storage: { kind: 'val', type: 'i32' }, mutable: true },
            ]},
        }
        const imm: WasmGcType = {
            name: '$Imm',
            spec: { kind: 'struct', fields: [
                { storage: { kind: 'val', type: 'i32' }, mutable: false },
            ]},
        }
        expect(reg.intern(mut)).toBe(0)
        expect(reg.intern(imm)).toBe(1)
    })

    test('intern distinguishes struct and array even with same element type', () => {
        const reg = new WasmGcTypeRegistry()
        const struct: WasmGcType = {
            name: '$Struct',
            spec: { kind: 'struct', fields: [
                { storage: { kind: 'val', type: 'i32' }, mutable: true },
            ]},
        }
        const array: WasmGcType = {
            name: '$Array',
            spec: { kind: 'array', element:
                { storage: { kind: 'val', type: 'i32' }, mutable: true },
            },
        }
        expect(reg.intern(struct)).toBe(0)
        expect(reg.intern(array)).toBe(1)
    })

    test('intern dedup spans ref-typed fields', () => {
        const reg = new WasmGcTypeRegistry()
        const vecHeader: WasmGcType = {
            name: '$Vec',
            spec: { kind: 'struct', fields: [
                { storage: { kind: 'val', type: 'i32' }, mutable: true },           // len
                { storage: { kind: 'ref', typeIdx: 0, nullable: false }, mutable: true },  // data
            ]},
        }
        expect(reg.intern(vecHeader)).toBe(0)
        expect(reg.intern({ ...vecHeader, name: '$VecOther' })).toBe(0)
        expect(reg.size()).toBe(1)
    })

    test('snapshot returns a copy — caller mutations do not leak back', () => {
        const reg = new WasmGcTypeRegistry()
        reg.intern({
            name: '$X',
            spec: { kind: 'array', element:
                { storage: { kind: 'val', type: 'i32' }, mutable: true },
            },
        })
        const snap = reg.snapshot()
        snap.push({ name: 'oops', spec: { kind: 'struct', fields: [] } } as any)
        expect(reg.size()).toBe(1)
    })
})

// ── 2. wasmGcTypeKey — structural identity ──────────────────────────────

describe('wasmGcTypeKey', () => {
    test('same key for two structs with identical layout but different names', () => {
        const a = wasmGcTypeKey({
            name: '$A',
            spec: { kind: 'struct', fields: [
                { storage: { kind: 'val', type: 'i32' }, mutable: true },
            ]},
        })
        const b = wasmGcTypeKey({
            name: '$B-different-name',
            spec: { kind: 'struct', fields: [
                { storage: { kind: 'val', type: 'i32' }, mutable: true },
            ]},
        })
        expect(a).toBe(b)
    })

    test('different key for struct vs array of same element type', () => {
        const s = wasmGcTypeKey({
            name: '$S',
            spec: { kind: 'struct', fields: [
                { storage: { kind: 'val', type: 'i32' }, mutable: true },
            ]},
        })
        const a = wasmGcTypeKey({
            name: '$A',
            spec: { kind: 'array', element:
                { storage: { kind: 'val', type: 'i32' }, mutable: true },
            },
        })
        expect(s).not.toBe(a)
    })

    test('packed and value with same nominal type are distinct', () => {
        // (struct (field (mut i8))) ≠ (struct (field (mut i32))) even
        // though both are i32-shaped on the operand stack — packed
        // types are storage-only.
        const packed = wasmGcTypeKey({
            name: '$P',
            spec: { kind: 'struct', fields: [
                { storage: { kind: 'packed', type: 'i8' }, mutable: true },
            ]},
        })
        const val = wasmGcTypeKey({
            name: '$V',
            spec: { kind: 'struct', fields: [
                { storage: { kind: 'val', type: 'i32' }, mutable: true },
            ]},
        })
        expect(packed).not.toBe(val)
    })
})

// ── 3. Binary type-section encoding ─────────────────────────────────────

describe('WasmGC type-section binary encoding', () => {

    test('struct with two mutable i32 fields encodes 0x5F + count + fields', () => {
        const mod: IRModule = {
            ...emptyUserModule(),
            wasmGcTypes: [{
                name: '$Point',
                spec: { kind: 'struct', fields: [
                    { storage: { kind: 'val', type: 'i32' }, mutable: true },
                    { storage: { kind: 'val', type: 'i32' }, mutable: true },
                ]},
            }],
        }
        const bin = emitWasmBinary(buildPrelude(1024, false), mod)
        const section = extractTypeSection(bin)
        // Find the GC type entry — it comes after any function types.
        // section[0] is the type count; one of the entries must start with 0x5F.
        const structFormPos = section.indexOf(0x5F)
        expect(structFormPos).toBeGreaterThan(0)
        // After 0x5F: field count (0x02), then each field = storage byte + mut byte.
        expect(section[structFormPos + 0]).toBe(0x5F)  // struct form
        expect(section[structFormPos + 1]).toBe(0x02)  // 2 fields
        expect(section[structFormPos + 2]).toBe(0x7F)  // field 0 = i32
        expect(section[structFormPos + 3]).toBe(0x01)  // field 0 mutable
        expect(section[structFormPos + 4]).toBe(0x7F)  // field 1 = i32
        expect(section[structFormPos + 5]).toBe(0x01)  // field 1 mutable
    })

    test('array of mutable i8 encodes 0x5E + 0x78 + 0x01', () => {
        const mod: IRModule = {
            ...emptyUserModule(),
            wasmGcTypes: [{
                name: '$String',
                spec: { kind: 'array', element:
                    { storage: { kind: 'packed', type: 'i8' }, mutable: true },
                },
            }],
        }
        const bin = emitWasmBinary(buildPrelude(1024, false), mod)
        const section = extractTypeSection(bin)
        const arrayFormPos = section.indexOf(0x5E)
        expect(arrayFormPos).toBeGreaterThan(0)
        expect(section[arrayFormPos + 0]).toBe(0x5E)  // array form
        expect(section[arrayFormPos + 1]).toBe(0x78)  // packed i8
        expect(section[arrayFormPos + 2]).toBe(0x01)  // mutable
    })

    test('struct with a (ref $Array_i32) field encodes 0x64 + typeidx', () => {
        // Simulates a Vec[Int] header: { len:i32, data:(ref $Array_i32) }
        // with the array declared at index N (here N = number of function
        // types + 0, since the array comes first in wasmGcTypes).
        // We construct both types in the right order: array first (idx N),
        // struct second (idx N+1).  buildPrelude has its own function
        // types so we don't hardcode N here — the test just verifies the
        // ref form byte and the SLEB-i32 typeidx encoding round-trips.
        const mod: IRModule = {
            ...emptyUserModule(),
            wasmGcTypes: [
                {
                    name: '$Array_i32',
                    spec: { kind: 'array', element:
                        { storage: { kind: 'val', type: 'i32' }, mutable: true },
                    },
                },
                {
                    name: '$Vec_i32',
                    spec: { kind: 'struct', fields: [
                        { storage: { kind: 'val', type: 'i32' }, mutable: true },
                        // Forward ref into the array we just declared.
                        // The actual typeidx depends on the prelude's
                        // function-type count; we don't pin it here, just
                        // verify the form byte appears.
                        { storage: { kind: 'ref', typeIdx: 99, nullable: false }, mutable: true },
                    ]},
                },
            ],
        }
        const bin = emitWasmBinary(buildPrelude(1024, false), mod)
        const section = extractTypeSection(bin)
        // The non-null ref form byte is 0x64 (WasmGC binary spec).
        const refFormPos = section.indexOf(REF_NON_NULL_BYTE)
        expect(refFormPos).toBeGreaterThan(0)
        // After the 0x64 byte, the SLEB128 of 99 is two bytes: 0xE3 0x00.
        expect(section[refFormPos]).toBe(0x64)
        expect(section[refFormPos + 1]).toBe(0xE3)
        expect(section[refFormPos + 2]).toBe(0x00)
    })

    test('empty wasmGcTypes preserves byte-equal codegen (wasm-mvp regression)', () => {
        // The mvp path must not emit any GC opcodes — every existing
        // determinism test depends on this.
        const mod: IRModule = emptyUserModule()
        const bin = emitWasmBinary(buildPrelude(1024, false), mod)
        const section = extractTypeSection(bin)
        expect(section.indexOf(0x5F)).toBe(-1)  // no struct form
        expect(section.indexOf(0x5E)).toBe(-1)  // no array form
    })

    test('type count includes both function types and gc types', () => {
        const modWithGc: IRModule = {
            ...emptyUserModule(),
            wasmGcTypes: [
                {
                    name: '$A',
                    spec: { kind: 'struct', fields: [
                        { storage: { kind: 'val', type: 'i32' }, mutable: true },
                    ]},
                },
            ],
        }
        const modWithoutGc: IRModule = emptyUserModule()
        const binA = emitWasmBinary(buildPrelude(1024, false), modWithGc)
        const binB = emitWasmBinary(buildPrelude(1024, false), modWithoutGc)
        const secA = extractTypeSection(binA)
        const secB = extractTypeSection(binB)
        // The first byte of each section body is the type count (ULEB128
        // single-byte for the tiny modules we emit).
        expect(secA[0]).toBe(secB[0] + 1)
    })
})

// ── 4. WebAssembly.compile round-trip validation ────────────────────────

describe('WasmGC type-section validation under WebAssembly.compile', () => {

    test('module with one struct + one array type is well-formed', async () => {
        const mod: IRModule = {
            ...emptyUserModule(),
            wasmGcTypes: [
                {
                    name: '$Array_i8',
                    spec: { kind: 'array', element:
                        { storage: { kind: 'packed', type: 'i8' }, mutable: true },
                    },
                },
                {
                    name: '$Point',
                    spec: { kind: 'struct', fields: [
                        { storage: { kind: 'val', type: 'i32' }, mutable: true },
                        { storage: { kind: 'val', type: 'i32' }, mutable: true },
                    ]},
                },
            ],
        }
        const bin = emitWasmBinary(buildPrelude(1024, false), mod)
        // Bun's wasm host has WasmGC support; compile asserts the binary
        // is structurally valid (type-section decode, type-checking, etc.).
        const compiled = await WebAssembly.compile(bin)
        expect(compiled).toBeDefined()
    })
})

const REF_NON_NULL_BYTE = 0x64
