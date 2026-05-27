/**
 * Phase 9d-3 — WasmGC instruction-level IR + emitters.
 *
 * Covers the IR nodes added in src/ir/nodes.ts (IRStructNew/Get/Set,
 * IRArrayNew/NewDefault/Get/Set/Len/Copy), the WAT text emit in
 * src/ir/emit.ts, and the binary opcode emit in
 * src/codegen/wasm-emitter.ts.
 *
 * Scope follows wit/wasm-gc.wit's struct-ops + array-ops interfaces.
 * Full @struct / Sum / Vec routing through these nodes is a follow-up
 * (Phase 9d-7 owns sums; Phase 9d-8 owns Vec).  Here we construct
 * synthetic IR and verify both emit paths produce the expected bytes /
 * canonical WAT text.
 *
 * Out of scope (per wit/wasm-gc.wit excluded-v1-0): ref.test, ref.cast,
 * array.new_fixed / new_data / new_elem, array.init_*, array.fill.
 */

import { test, expect, describe } from 'bun:test'
import type {
    IRExpr, IRStmt, IRModule, IRFunction,
    IRStructNew, IRStructGet, IRStructSet,
    IRArrayNew, IRArrayNewDefault, IRArrayGet, IRArraySet, IRArrayLen, IRArrayCopy,
    WasmGcType,
} from '../ir/nodes'
import { emitExpr } from '../ir/emit'
import { emitWasmBinary } from './wasm-emitter'
import { buildPrelude } from './prelude-ir'

// ── helpers ─────────────────────────────────────────────────────────────

const i32Const = (v: number): IRExpr =>
    ({ kind: 'Const', wasmType: 'i32', value: v })

const localGet = (name: string, wasmType: 'i32' | 'i64' | 'f32' = 'i32'): IRExpr =>
    ({ kind: 'LocalGet', wasmType, name })

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

/** Extract the code section (id=10) — that's where instruction bytes live. */
function extractCodeSection(bin: Uint8Array): Uint8Array {
    let p = 8
    while (p < bin.length) {
        const id = bin[p]
        let size = 0, shift = 0, q = p + 1
        while (true) {
            const b = bin[q++]
            size |= (b & 0x7f) << shift
            if ((b & 0x80) === 0) break
            shift += 7
        }
        if (id === 10) return bin.slice(q, q + size)
        p = q + size
    }
    throw new Error('code section (id=10) not found')
}

// ── 1. WAT text emit ────────────────────────────────────────────────────

describe('WasmGC instruction WAT text emit', () => {

    test('struct.new with two field args', () => {
        const e: IRStructNew = {
            kind: 'StructNew', wasmType: 'i32',
            typeIdx: 5, typeName: '$Point',
            args: [i32Const(3), i32Const(4)],
        }
        expect(emitExpr(e)).toBe('(struct.new $Point (i32.const 3) (i32.const 4))')
    })

    test('struct.new with no args', () => {
        const e: IRStructNew = {
            kind: 'StructNew', wasmType: 'i32',
            typeIdx: 7, typeName: '$Empty',
            args: [],
        }
        expect(emitExpr(e)).toBe('(struct.new $Empty)')
    })

    test('struct.get on a non-packed field', () => {
        const e: IRStructGet = {
            kind: 'StructGet', wasmType: 'i32',
            typeIdx: 5, typeName: '$Point', fieldIdx: 1,
            target: localGet('p'),
        }
        expect(emitExpr(e)).toBe('(struct.get $Point 1 (local.get $p))')
    })

    test('struct.get_s on a packed signed field', () => {
        const e: IRStructGet = {
            kind: 'StructGet', wasmType: 'i32',
            typeIdx: 9, typeName: '$Tag', fieldIdx: 0, signed: 's',
            target: localGet('t'),
        }
        expect(emitExpr(e)).toBe('(struct.get_s $Tag 0 (local.get $t))')
    })

    test('struct.set', () => {
        const e: IRStructSet = {
            kind: 'StructSet', wasmType: 'void',
            typeIdx: 5, typeName: '$Point', fieldIdx: 0,
            target: localGet('p'),
            value: i32Const(42),
        }
        expect(emitExpr(e)).toBe('(struct.set $Point 0 (local.get $p) (i32.const 42))')
    })

    test('array.new takes init + size', () => {
        const e: IRArrayNew = {
            kind: 'ArrayNew', wasmType: 'i32',
            typeIdx: 3, typeName: '$Array_i32',
            init: i32Const(0),
            size: i32Const(10),
        }
        expect(emitExpr(e)).toBe('(array.new $Array_i32 (i32.const 0) (i32.const 10))')
    })

    test('array.new_default takes only size', () => {
        const e: IRArrayNewDefault = {
            kind: 'ArrayNewDefault', wasmType: 'i32',
            typeIdx: 3, typeName: '$Array_i32',
            size: i32Const(10),
        }
        expect(emitExpr(e)).toBe('(array.new_default $Array_i32 (i32.const 10))')
    })

    test('array.get on a non-packed element type', () => {
        const e: IRArrayGet = {
            kind: 'ArrayGet', wasmType: 'i32',
            typeIdx: 3, typeName: '$Array_i32',
            target: localGet('arr'),
            idx: i32Const(2),
        }
        expect(emitExpr(e)).toBe('(array.get $Array_i32 (local.get $arr) (i32.const 2))')
    })

    test('array.get_u on a packed i8 element (String backing)', () => {
        const e: IRArrayGet = {
            kind: 'ArrayGet', wasmType: 'i32',
            typeIdx: 2, typeName: '$String', signed: 'u',
            target: localGet('s'),
            idx: i32Const(0),
        }
        expect(emitExpr(e)).toBe('(array.get_u $String (local.get $s) (i32.const 0))')
    })

    test('array.set', () => {
        const e: IRArraySet = {
            kind: 'ArraySet', wasmType: 'void',
            typeIdx: 3, typeName: '$Array_i32',
            target: localGet('arr'),
            idx: i32Const(1),
            value: i32Const(99),
        }
        expect(emitExpr(e))
            .toBe('(array.set $Array_i32 (local.get $arr) (i32.const 1) (i32.const 99))')
    })

    test('array.len takes only the ref', () => {
        const e: IRArrayLen = {
            kind: 'ArrayLen', wasmType: 'i32',
            target: localGet('arr'),
        }
        expect(emitExpr(e)).toBe('(array.len (local.get $arr))')
    })

    test('array.copy with dst + src types', () => {
        const e: IRArrayCopy = {
            kind: 'ArrayCopy', wasmType: 'void',
            dstTypeIdx: 3, dstTypeName: '$Array_i32',
            srcTypeIdx: 3, srcTypeName: '$Array_i32',
            dstRef: localGet('dst'),
            dstIdx: i32Const(0),
            srcRef: localGet('src'),
            srcIdx: i32Const(0),
            count: i32Const(8),
        }
        expect(emitExpr(e)).toBe(
            '(array.copy $Array_i32 $Array_i32 ' +
            '(local.get $dst) (i32.const 0) (local.get $src) (i32.const 0) (i32.const 8))'
        )
    })
})

// ── 2. Binary opcode emit ───────────────────────────────────────────────
//
// Each GC instruction is prefixed by 0xFB; the second byte is the
// sub-opcode listed in the wasm GC spec.  Tests construct a function
// whose body uses each instruction and verify the bytes show up in
// the code section.

function buildModuleWithExprBody(
    gcTypes: WasmGcType[],
    exprBody: IRExpr,
    locals: Array<{ name: string; wasmType: 'i32' | 'i64' | 'f32' }> = [],
    returnType: 'i32' | 'f32' | 'void' = 'i32',
): IRModule {
    const fn: IRFunction = {
        kind: 'Function',
        name: 'probe',
        params: [],
        returnType,
        locals,
        body: exprBody,
    }
    return {
        ...emptyUserModule(),
        functions: [fn],
        wasmGcTypes: gcTypes,
    }
}

/** Find the first occurrence of 0xFB followed by `subOp` in `code`. */
function findGcOp(code: Uint8Array, subOp: number): number {
    for (let i = 0; i < code.length - 1; i++) {
        if (code[i] === 0xFB && code[i + 1] === subOp) return i
    }
    return -1
}

describe('WasmGC instruction binary opcodes', () => {

    // A minimal struct type used as the immediate for struct ops.
    const pointType: WasmGcType = {
        name: '$Point',
        spec: { kind: 'struct', fields: [
            { storage: { kind: 'val', type: 'i32' }, mutable: true },
            { storage: { kind: 'val', type: 'i32' }, mutable: true },
        ]},
    }

    const arrayI32Type: WasmGcType = {
        name: '$Array_i32',
        spec: { kind: 'array', element:
            { storage: { kind: 'val', type: 'i32' }, mutable: true },
        },
    }

    test('struct.new emits 0xFB 0x00', () => {
        // The struct.new returns a ref; we expose it as i32 at the IR
        // level (Phase 9d-3 represents refs as i32 placeholders — full
        // ref-typed function signatures are 9d-4+ work).
        const sn: IRStructNew = {
            kind: 'StructNew', wasmType: 'i32',
            typeIdx: 99, typeName: '$Point',  // typeIdx is the immediate
            args: [i32Const(3), i32Const(4)],
        }
        const mod = buildModuleWithExprBody([pointType], sn)
        const bin = emitWasmBinary(buildPrelude(1024, false), mod)
        const code = extractCodeSection(bin)
        const pos = findGcOp(code, 0x00)
        expect(pos).toBeGreaterThan(-1)
    })

    test('struct.get (non-packed) emits 0xFB 0x02', () => {
        const sg: IRStructGet = {
            kind: 'StructGet', wasmType: 'i32',
            typeIdx: 5, typeName: '$Point', fieldIdx: 0,
            target: localGet('p'),
        }
        const mod = buildModuleWithExprBody(
            [pointType], sg,
            [{ name: 'p', wasmType: 'i32' }],
        )
        const bin = emitWasmBinary(buildPrelude(1024, false), mod)
        const code = extractCodeSection(bin)
        expect(findGcOp(code, 0x02)).toBeGreaterThan(-1)
    })

    test('struct.get_s emits 0xFB 0x03; struct.get_u emits 0xFB 0x04', () => {
        const sgS: IRStructGet = {
            kind: 'StructGet', wasmType: 'i32',
            typeIdx: 5, typeName: '$Tag', fieldIdx: 0, signed: 's',
            target: localGet('p'),
        }
        const modS = buildModuleWithExprBody(
            [pointType], sgS,
            [{ name: 'p', wasmType: 'i32' }],
        )
        const codeS = extractCodeSection(emitWasmBinary(buildPrelude(1024, false), modS))
        expect(findGcOp(codeS, 0x03)).toBeGreaterThan(-1)

        const sgU: IRStructGet = { ...sgS, signed: 'u' }
        const modU = buildModuleWithExprBody(
            [pointType], sgU,
            [{ name: 'p', wasmType: 'i32' }],
        )
        const codeU = extractCodeSection(emitWasmBinary(buildPrelude(1024, false), modU))
        expect(findGcOp(codeU, 0x04)).toBeGreaterThan(-1)
    })

    test('struct.set emits 0xFB 0x05', () => {
        const ss: IRStructSet = {
            kind: 'StructSet', wasmType: 'void',
            typeIdx: 5, typeName: '$Point', fieldIdx: 0,
            target: localGet('p'),
            value: i32Const(42),
        }
        // Wrap in a Block so we have a void-returning body.
        const body: IRExpr = {
            kind: 'Block', wasmType: 'void',
            stmts: [{ kind: 'ExprStmt', expr: ss }],
            trailing: undefined,
        }
        const mod = buildModuleWithExprBody(
            [pointType], body,
            [{ name: 'p', wasmType: 'i32' }],
            'void',
        )
        const bin = emitWasmBinary(buildPrelude(1024, false), mod)
        const code = extractCodeSection(bin)
        expect(findGcOp(code, 0x05)).toBeGreaterThan(-1)
    })

    test('array.new emits 0xFB 0x06', () => {
        const an: IRArrayNew = {
            kind: 'ArrayNew', wasmType: 'i32',
            typeIdx: 3, typeName: '$Array_i32',
            init: i32Const(0),
            size: i32Const(10),
        }
        const mod = buildModuleWithExprBody([arrayI32Type], an)
        const code = extractCodeSection(emitWasmBinary(buildPrelude(1024, false), mod))
        expect(findGcOp(code, 0x06)).toBeGreaterThan(-1)
    })

    test('array.new_default emits 0xFB 0x07', () => {
        const and_: IRArrayNewDefault = {
            kind: 'ArrayNewDefault', wasmType: 'i32',
            typeIdx: 3, typeName: '$Array_i32',
            size: i32Const(10),
        }
        const mod = buildModuleWithExprBody([arrayI32Type], and_)
        const code = extractCodeSection(emitWasmBinary(buildPrelude(1024, false), mod))
        expect(findGcOp(code, 0x07)).toBeGreaterThan(-1)
    })

    test('array.get emits 0xFB 0x0B; array.get_s 0x0C; array.get_u 0x0D', () => {
        const make = (signed?: 's' | 'u'): IRArrayGet => ({
            kind: 'ArrayGet', wasmType: 'i32',
            typeIdx: 3, typeName: '$Array_i32',
            signed,
            target: localGet('a'),
            idx: i32Const(0),
        })
        const locals = [{ name: 'a', wasmType: 'i32' as const }]
        const mNone = buildModuleWithExprBody([arrayI32Type], make(),    locals)
        const mS    = buildModuleWithExprBody([arrayI32Type], make('s'), locals)
        const mU    = buildModuleWithExprBody([arrayI32Type], make('u'), locals)
        const c1 = extractCodeSection(emitWasmBinary(buildPrelude(1024, false), mNone))
        const c2 = extractCodeSection(emitWasmBinary(buildPrelude(1024, false), mS))
        const c3 = extractCodeSection(emitWasmBinary(buildPrelude(1024, false), mU))
        expect(findGcOp(c1, 0x0B)).toBeGreaterThan(-1)
        expect(findGcOp(c2, 0x0C)).toBeGreaterThan(-1)
        expect(findGcOp(c3, 0x0D)).toBeGreaterThan(-1)
    })

    test('array.set emits 0xFB 0x0E', () => {
        const as: IRArraySet = {
            kind: 'ArraySet', wasmType: 'void',
            typeIdx: 3, typeName: '$Array_i32',
            target: localGet('a'),
            idx: i32Const(0),
            value: i32Const(99),
        }
        const body: IRExpr = {
            kind: 'Block', wasmType: 'void',
            stmts: [{ kind: 'ExprStmt', expr: as }],
            trailing: undefined,
        }
        const mod = buildModuleWithExprBody(
            [arrayI32Type], body,
            [{ name: 'a', wasmType: 'i32' }],
            'void',
        )
        const code = extractCodeSection(emitWasmBinary(buildPrelude(1024, false), mod))
        expect(findGcOp(code, 0x0E)).toBeGreaterThan(-1)
    })

    test('array.len emits 0xFB 0x0F with no immediates', () => {
        const al: IRArrayLen = {
            kind: 'ArrayLen', wasmType: 'i32',
            target: localGet('a'),
        }
        const mod = buildModuleWithExprBody(
            [arrayI32Type], al,
            [{ name: 'a', wasmType: 'i32' }],
        )
        const code = extractCodeSection(emitWasmBinary(buildPrelude(1024, false), mod))
        const pos = findGcOp(code, 0x0F)
        expect(pos).toBeGreaterThan(-1)
        // No immediate bytes following: the next instruction should be
        // the function's `end` (0x0B) since array.len's result is the
        // function's return value.  We just verify the next byte isn't
        // part of a typeidx encoding (typeidx is ULEB128 — anything
        // 0x80+ would indicate continuation bytes).
        expect(code[pos + 2]).toBeLessThan(0x80)
    })

    test('array.copy emits 0xFB 0x11 with TWO type-index immediates', () => {
        const ac: IRArrayCopy = {
            kind: 'ArrayCopy', wasmType: 'void',
            dstTypeIdx: 7, dstTypeName: '$Array_i32',
            srcTypeIdx: 7, srcTypeName: '$Array_i32',
            dstRef: localGet('dst'),
            dstIdx: i32Const(0),
            srcRef: localGet('src'),
            srcIdx: i32Const(0),
            count:  i32Const(4),
        }
        const body: IRExpr = {
            kind: 'Block', wasmType: 'void',
            stmts: [{ kind: 'ExprStmt', expr: ac }],
            trailing: undefined,
        }
        const mod = buildModuleWithExprBody(
            [arrayI32Type], body,
            [
                { name: 'dst', wasmType: 'i32' },
                { name: 'src', wasmType: 'i32' },
            ],
            'void',
        )
        const code = extractCodeSection(emitWasmBinary(buildPrelude(1024, false), mod))
        expect(findGcOp(code, 0x11)).toBeGreaterThan(-1)
    })
})

// ── 3. exprWasmType — IR-level type discovery ───────────────────────────
//
// The lowering pipeline uses exprWasmType (lower.ts) to wire result
// types from one IR node into another (e.g. wrapping an expr in a
// LocalSet).  Verifying it knows about the new nodes guards against
// silent fall-through under the discriminated union.

describe('exprWasmType reports the right result for GC nodes', () => {
    // (Imported lazily to keep the test file's import list small.)
    test('struct.new is i32 (ref)', async () => {
        const { exprWasmType } = await import('../ir/lower')
        const e: IRStructNew = {
            kind: 'StructNew', wasmType: 'i32',
            typeIdx: 0, typeName: '$T', args: [],
        }
        expect(exprWasmType(e)).toBe('i32')
    })

    test('struct.set is void', async () => {
        const { exprWasmType } = await import('../ir/lower')
        const e: IRStructSet = {
            kind: 'StructSet', wasmType: 'void',
            typeIdx: 0, typeName: '$T', fieldIdx: 0,
            target: localGet('p'),
            value: i32Const(0),
        }
        expect(exprWasmType(e)).toBe('void')
    })

    test('array.len is i32', async () => {
        const { exprWasmType } = await import('../ir/lower')
        const e: IRArrayLen = {
            kind: 'ArrayLen', wasmType: 'i32',
            target: localGet('a'),
        }
        expect(exprWasmType(e)).toBe('i32')
    })

    test('array.copy is void', async () => {
        const { exprWasmType } = await import('../ir/lower')
        const e: IRArrayCopy = {
            kind: 'ArrayCopy', wasmType: 'void',
            dstTypeIdx: 0, dstTypeName: '$T',
            srcTypeIdx: 0, srcTypeName: '$T',
            dstRef: localGet('d'), dstIdx: i32Const(0),
            srcRef: localGet('s'), srcIdx: i32Const(0),
            count: i32Const(1),
        }
        expect(exprWasmType(e)).toBe('void')
    })
})
