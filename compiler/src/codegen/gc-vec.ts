// SPDX-License-Identifier: MIT
/**
 * Phase 9d-8 — Vec[T] for value-typed T under --target=wasm-gc.
 *
 * Mirrors the surface API of `src/stdlib/vec.si` but uses WasmGC
 * struct.new / array.new instead of linear-memory bump allocation.
 *
 * Layout:
 *   $Array_i32  := (array (mut i32))
 *   $Vec_i32    := (struct (mut i32) (mut (ref $Array_i32)))
 *                       ^len           ^data array
 *
 * Capacity = `array.len data` (engine-provided, no separate field).
 *
 * Scope (per ADR 0009 §3 — v1.1 follow-ups deliberately deferred):
 *   - Only `Vec[Int]` (i32 element type).  f32 / i64 / unsigned
 *     variants are mechanical extensions; v1.1 if needed.
 *   - Only value-typed elements.  `Vec[String]` / `Vec[@struct Foo]`
 *     require ref-typed array elements + variance design (v1.1).
 *   - No fully generic `@fn vec_push[T] v:Vec[T], x:T` — the existing
 *     specialised-name scheme (`vec_push_i32`) matches today's mvp
 *     vec.si; full monomorphisation is v1.1.
 *
 * The functions emitted here are injected into the user lowering at
 * the start of `lowerProgram` when `target === 'wasm-gc'`, BEFORE any
 * user-defined types or functions.  That way:
 *   - $Array_i32 and $Vec_i32 get the lowest WasmGC type indices,
 *     so the prelude functions' refResult / refParams reference them
 *     by stable, known positions.
 *   - The internNominal call adds them to LowerCtx.wasmGcTypes — the
 *     same registry user @type sums use — so the merged module emits
 *     one consistent type section.
 */

import type {
    IRExpr, IRStmt, IRFunction, IRParam, IRLocal, WasmValType,
    WasmGcType, IRRefSlot, IRStructNew, IRStructGet, IRStructSet,
    IRArrayNew, IRArrayNewDefault, IRArrayGet, IRArraySet, IRArrayLen, IRArrayCopy,
} from '../ir/nodes'
import type { WasmGcTypeRegistry } from '../ir/nodes'

const i32 = 'i32' as const
const void_ = 'void' as const

// ── micro-builders ──────────────────────────────────────────────────────

const c = (value: number, wt: WasmValType = i32): IRExpr =>
    ({ kind: 'Const', wasmType: wt, value })

const lg = (name: string, wt: WasmValType = i32): IRExpr =>
    ({ kind: 'LocalGet', wasmType: wt, name })

const ls = (name: string, value: IRExpr): IRStmt =>
    ({ kind: 'LocalSet', name, value })

const binop = (op: any, left: IRExpr, right: IRExpr): IRExpr =>
    ({ kind: 'BinOp', wasmType: 'i32', op, left, right })

const stmt = (expr: IRExpr): IRStmt => ({ kind: 'ExprStmt', expr })

const block = (stmts: IRStmt[], trailing?: IRExpr): IRExpr => {
    const wasmType = trailing ? ((trailing as any).wasmType ?? 'i32') : 'void'
    return { kind: 'Block', wasmType, stmts, trailing }
}

const iif = (cond: IRExpr, then: IRExpr, else_?: IRExpr): IRExpr => {
    const wasmType = else_ ? ((then as any).wasmType ?? 'i32') : 'void'
    return { kind: 'If', wasmType, cond, then, else_ }
}

// ── GC instruction builders ────────────────────────────────────────────

const structNew = (typeIdx: number, typeName: string, args: IRExpr[]): IRStructNew =>
    ({ kind: 'StructNew', wasmType: 'i32', typeIdx, typeName, args })

const structGet = (typeIdx: number, typeName: string, fieldIdx: number, target: IRExpr): IRStructGet =>
    ({ kind: 'StructGet', wasmType: 'i32', typeIdx, typeName, fieldIdx, target })

const structSet = (typeIdx: number, typeName: string, fieldIdx: number, target: IRExpr, value: IRExpr): IRStructSet =>
    ({ kind: 'StructSet', wasmType: 'void', typeIdx, typeName, fieldIdx, target, value })

const arrayNewDefault = (typeIdx: number, typeName: string, size: IRExpr): IRArrayNewDefault =>
    ({ kind: 'ArrayNewDefault', wasmType: 'i32', typeIdx, typeName, size })

// Non-packed array element: plain `array.get` (no signedness suffix).
// The signed/unsigned variants are reserved for packed i8 / i16 elements.
const arrayGet = (typeIdx: number, typeName: string, target: IRExpr, idx: IRExpr): IRArrayGet =>
    ({ kind: 'ArrayGet', wasmType: 'i32', typeIdx, typeName, target, idx })

const arraySet = (typeIdx: number, typeName: string, target: IRExpr, idx: IRExpr, value: IRExpr): IRArraySet =>
    ({ kind: 'ArraySet', wasmType: 'void', typeIdx, typeName, target, idx, value })

const arrayLen = (target: IRExpr): IRArrayLen =>
    ({ kind: 'ArrayLen', wasmType: 'i32', target })

const arrayCopy = (
    typeIdx: number, typeName: string,
    dstRef: IRExpr, dstIdx: IRExpr,
    srcRef: IRExpr, srcIdx: IRExpr, count: IRExpr,
): IRArrayCopy =>
    ({ kind: 'ArrayCopy', wasmType: 'void',
       dstTypeIdx: typeIdx, dstTypeName: typeName,
       srcTypeIdx: typeIdx, srcTypeName: typeName,
       dstRef, dstIdx, srcRef, srcIdx, count })

// ── Function builder ───────────────────────────────────────────────────

interface RefSlotSpec {
    /** Function param index OR -1 for result. */
    slot: 'result' | number
    /** localTypeIdx in the wasmGcTypes registry. */
    typeIdx: number
}

/** A local slot — name + wasmType, plus optional ref-typeidx for
 *  locals that hold managed refs (`new_data: ref $Array_i32` etc.). */
type LocalSpec = [string, WasmValType] | [string, WasmValType, number /* refTypeIdx */]

function gcFn(
    name: string,
    params: Array<[string, WasmValType]>,
    returnType: 'i32' | 'void',
    locals: LocalSpec[],
    body: IRExpr,
    refSlots: RefSlotSpec[] = [],
): IRFunction {
    const fn: IRFunction = {
        kind: 'Function',
        name,
        params: params.map(([n, t]) => ({ name: n, wasmType: t })),
        returnType,
        locals: locals.map(spec => {
            const [n, t, refIdx] = spec
            const local: IRLocal = { name: n, wasmType: t }
            if (refIdx !== undefined) {
                local.refType = { localTypeIdx: refIdx, nullable: false }
            }
            return local
        }),
        body,
    }
    for (const r of refSlots) {
        const slot: IRRefSlot = { localTypeIdx: r.typeIdx, nullable: false }
        if (r.slot === 'result') {
            fn.refResult = slot
        } else {
            if (!fn.refParams) fn.refParams = new Map()
            fn.refParams.set(r.slot, slot)
        }
    }
    return fn
}

// ── Vec[Int] (i32) implementations ──────────────────────────────────────

const ARRAY_I32 = '$Array_i32'
const VEC_I32   = '$Vec_i32'

/** Register $Array_i32 and $Vec_i32 in the registry.  Returns the
 *  type indices for downstream callers (constructors / sum lowering
 *  that might reference them in v1.1). */
export function registerGcVecTypes(reg: WasmGcTypeRegistry): { arrayIdx: number; vecIdx: number } {
    const arrayIdx = reg.internNominal({
        name: ARRAY_I32,
        spec: {
            kind: 'array',
            element: { storage: { kind: 'val', type: 'i32' }, mutable: true },
        },
    })
    // $Vec_i32 has a ref to $Array_i32 at field 1; WasmGC's forward-ref
    // rule means $Array_i32 must be declared FIRST (lower index).  The
    // intern order above guarantees that.
    const vecIdx = reg.internNominal({
        name: VEC_I32,
        spec: {
            kind: 'struct',
            fields: [
                { storage: { kind: 'val', type: 'i32' }, mutable: true },                          // len
                { storage: { kind: 'ref', typeIdx: arrayIdx, nullable: false }, mutable: true },  // data
            ],
        },
    })
    return { arrayIdx, vecIdx }
}

/** vec_new(cap: i32) → (ref $Vec_i32)
 *
 *     struct.new $Vec_i32
 *         (i32.const 0)                                    ;; len = 0
 *         (array.new_default $Array_i32 (local.get $cap))  ;; data
 */
function buildVecNew(arrayIdx: number, vecIdx: number): IRFunction {
    const body = structNew(vecIdx, VEC_I32, [
        c(0),
        arrayNewDefault(arrayIdx, ARRAY_I32, lg('cap')),
    ])
    return gcFn('vec_new', [['cap', i32]], i32, [], body,
        [{ slot: 'result', typeIdx: vecIdx }])
}

/** vec_len(v: ref $Vec_i32) → i32 = struct.get $Vec_i32 0 v */
function buildVecLen(vecIdx: number): IRFunction {
    const body = structGet(vecIdx, VEC_I32, 0, lg('v'))
    return gcFn('vec_len', [['v', i32]], i32, [], body,
        [{ slot: 0, typeIdx: vecIdx }])
}

/** vec_capacity(v) → array.len (struct.get $Vec_i32 1 v) */
function buildVecCapacity(vecIdx: number): IRFunction {
    const body = arrayLen(structGet(vecIdx, VEC_I32, 1, lg('v')))
    return gcFn('vec_capacity', [['v', i32]], i32, [], body,
        [{ slot: 0, typeIdx: vecIdx }])
}

/** vec_get_i32(v, i) → array.get_s $Array_i32 (struct.get $Vec_i32 1 v) i */
function buildVecGetI32(arrayIdx: number, vecIdx: number): IRFunction {
    const body = arrayGet(arrayIdx, ARRAY_I32,
        structGet(vecIdx, VEC_I32, 1, lg('v')),
        lg('i'))
    return gcFn('vec_get_i32', [['v', i32], ['i', i32]], i32, [], body,
        [{ slot: 0, typeIdx: vecIdx }])
}

/** vec_set_i32(v, i, x) — array.set $Array_i32 data i x */
function buildVecSetI32(arrayIdx: number, vecIdx: number): IRFunction {
    const body = block([stmt(arraySet(arrayIdx, ARRAY_I32,
        structGet(vecIdx, VEC_I32, 1, lg('v')),
        lg('i'), lg('x')))])
    return gcFn('vec_set_i32', [['v', i32], ['i', i32], ['x', i32]], void_, [], body,
        [{ slot: 0, typeIdx: vecIdx }])
}

/** vec_push_i32(v, x)
 *
 *     len  := struct.get $Vec_i32 0 v
 *     data := struct.get $Vec_i32 1 v
 *     cap  := array.len data
 *     @if len >= cap, {
 *         new_cap := cap * 2 ; @if (cap == 0) new_cap := 4
 *         new_data := array.new_default $Array_i32 new_cap
 *         array.copy $Array_i32 new_data 0 data 0 len
 *         struct.set $Vec_i32 1 v new_data
 *     }
 *     array.set $Array_i32 (struct.get $Vec_i32 1 v) len x
 *     struct.set $Vec_i32 0 v (len + 1)
 */
function buildVecPushI32(arrayIdx: number, vecIdx: number): IRFunction {
    const len = lg('len')
    const cap = lg('cap')
    const newCap = lg('new_cap')
    const v = lg('v')

    const growBody = block([
        // new_cap := cap * 2 (or 4 if cap == 0)
        ls('new_cap', iif(
            binop('i32_eq', cap, c(0)),
            c(4),
            binop('i32_mul', cap, c(2)),
        )),
        // new_data := array.new_default $Array_i32 new_cap
        ls('new_data', arrayNewDefault(arrayIdx, ARRAY_I32, newCap)),
        // array.copy from old data to new
        stmt(arrayCopy(arrayIdx, ARRAY_I32,
            lg('new_data'), c(0),
            structGet(vecIdx, VEC_I32, 1, v), c(0),
            len)),
        // struct.set $Vec_i32 1 v new_data
        stmt(structSet(vecIdx, VEC_I32, 1, v, lg('new_data'))),
    ])

    const body = block([
        ls('len',  structGet(vecIdx, VEC_I32, 0, v)),
        ls('cap',  arrayLen(structGet(vecIdx, VEC_I32, 1, v))),
        stmt(iif(binop('i32_ge_s', len, cap), growBody)),
        // array.set $Array_i32 (struct.get … 1 v) len x
        stmt(arraySet(arrayIdx, ARRAY_I32,
            structGet(vecIdx, VEC_I32, 1, v),
            len, lg('x'))),
        // struct.set $Vec_i32 0 v (len + 1)
        stmt(structSet(vecIdx, VEC_I32, 0, v, binop('i32_add', len, c(1)))),
    ])

    return gcFn('vec_push_i32',
        [['v', i32], ['x', i32]],
        void_,
        [
            ['len', i32],
            ['cap', i32],
            ['new_cap', i32],
            // `new_data` holds a (ref $Array_i32) — declared as such so
            // array.new_default's result can be stored via local.set.
            ['new_data', i32, arrayIdx],
        ],
        body,
        [{ slot: 0, typeIdx: vecIdx }])
}

/** vec_pop_i32(v) → i32
 *
 *     len := struct.get $Vec_i32 0 v
 *     val := array.get_s $Array_i32 (struct.get … 1 v) (len - 1)
 *     struct.set $Vec_i32 0 v (len - 1)
 *     val
 */
function buildVecPopI32(arrayIdx: number, vecIdx: number): IRFunction {
    const len = lg('len')
    const v = lg('v')
    const body = block([
        ls('len', structGet(vecIdx, VEC_I32, 0, v)),
        ls('val', arrayGet(arrayIdx, ARRAY_I32,
            structGet(vecIdx, VEC_I32, 1, v),
            binop('i32_sub', len, c(1)))),
        stmt(structSet(vecIdx, VEC_I32, 0, v, binop('i32_sub', len, c(1)))),
    ], lg('val'))

    return gcFn('vec_pop_i32', [['v', i32]], i32,
        [['len', i32], ['val', i32]],
        body,
        [{ slot: 0, typeIdx: vecIdx }])
}

// ── Public injection point ──────────────────────────────────────────────

/** Phase 9d-8: register $Array_i32 + $Vec_i32 in the WasmGC type
 *  registry and emit the seven vec_* functions.  Caller (lowerProgram
 *  under target='wasm-gc') splices the returned functions into
 *  IRModule.functions BEFORE user-emitted functions, so the call
 *  index space is stable and predictable. */
export function buildGcVecExtension(reg: WasmGcTypeRegistry): IRFunction[] {
    const { arrayIdx, vecIdx } = registerGcVecTypes(reg)
    return [
        buildVecNew(arrayIdx, vecIdx),
        buildVecLen(vecIdx),
        buildVecCapacity(vecIdx),
        buildVecGetI32(arrayIdx, vecIdx),
        buildVecSetI32(arrayIdx, vecIdx),
        buildVecPushI32(arrayIdx, vecIdx),
        buildVecPopI32(arrayIdx, vecIdx),
    ]
}
