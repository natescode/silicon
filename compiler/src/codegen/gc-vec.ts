// SPDX-License-Identifier: MIT
/**
 * Vec[T] for value-typed T under --target=wasm-gc.
 *
 * Mirrors the surface API of `src/stdlib/vec.si` but uses WasmGC
 * struct.new / array.new instead of linear-memory bump allocation.
 *
 * Layout (per element type T):
 *   $Array_<T>  := (array (mut T))
 *   $Vec_<T>    := (struct (mut i32) (mut (ref $Array_<T>)))
 *                       ^len            ^data array
 *
 * Capacity = `array.len data` (engine-provided, no separate field).
 *
 * M1 (ADR 0001 / ADR 0009 M-8): monomorphic per element type.  `i32` is
 * always emitted; `f32` (Float) and `i64` (Int64) are emitted on demand
 * when a program uses `Vec[Float]` / `Vec[Int64]` (detected from the typed
 * program in lowerProgram).  The element type lives in the GC array type,
 * so per-element widening is "free" — `array.get`/`array.set` are
 * type-indexed; only the IR operand wasmType + the type/function names
 * differ.  The i32 emission is byte-identical to the pre-M1 output.
 *
 * Injected at the start of lowerProgram (target='wasm-gc') BEFORE user
 * types/functions so the Vec types get the lowest WasmGC type indices and
 * the prelude functions reference them by stable positions.
 */

import type {
    IRExpr, IRStmt, IRFunction, IRLocal, WasmValType,
    IRStructNew, IRStructGet, IRStructSet,
    IRArrayNewDefault, IRArrayGet, IRArraySet, IRArrayLen, IRArrayCopy,
} from '../ir/nodes'
import type { WasmGcTypeRegistry } from '../ir/nodes'

const i32 = 'i32' as const
const void_ = 'void' as const

// ── per-element-type spec ───────────────────────────────────────────────

interface ElemSpec {
    /** The element wasm value type. */
    elem: WasmValType
    /** WasmGC type names. */
    arrayName: string
    vecName: string
    /** Surface function names (the i32 set keeps the historical unsuffixed
     *  new/len/capacity to stay byte-identical with the pre-M1 output). */
    fn: { new: string; len: string; cap: string; get: string; set: string; push: string; pop: string }
}

const SPECS: Record<'i32' | 'f32' | 'i64', ElemSpec> = {
    i32: {
        elem: 'i32', arrayName: '$Array_i32', vecName: '$Vec_i32',
        fn: { new: 'vec_new', len: 'vec_len', cap: 'vec_capacity',
              get: 'vec_get_i32', set: 'vec_set_i32', push: 'vec_push_i32', pop: 'vec_pop_i32' },
    },
    f32: {
        elem: 'f32', arrayName: '$Array_f32', vecName: '$Vec_f32',
        fn: { new: 'vec_new_f32', len: 'vec_len_f32', cap: 'vec_capacity_f32',
              get: 'vec_get_f32', set: 'vec_set_f32', push: 'vec_push_f32', pop: 'vec_pop_f32' },
    },
    i64: {
        elem: 'i64', arrayName: '$Array_i64', vecName: '$Vec_i64',
        fn: { new: 'vec_new_i64', len: 'vec_len_i64', cap: 'vec_capacity_i64',
              get: 'vec_get_i64', set: 'vec_set_i64', push: 'vec_push_i64', pop: 'vec_pop_i64' },
    },
}

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
// The struct ref is i32-shaped on the operand stack; array element ops
// carry the element wasmType (`et`) so downstream stack typing is correct
// (the array.get/set bytecode itself is type-indexed by $Array_<T>).

const structNew = (typeIdx: number, typeName: string, args: IRExpr[]): IRStructNew =>
    ({ kind: 'StructNew', wasmType: 'i32', typeIdx, typeName, args })

const structGet = (typeIdx: number, typeName: string, fieldIdx: number, target: IRExpr, wt: WasmValType = 'i32'): IRStructGet =>
    ({ kind: 'StructGet', wasmType: wt, typeIdx, typeName, fieldIdx, target })

const structSet = (typeIdx: number, typeName: string, fieldIdx: number, target: IRExpr, value: IRExpr): IRStructSet =>
    ({ kind: 'StructSet', wasmType: 'void', typeIdx, typeName, fieldIdx, target, value })

const arrayNewDefault = (typeIdx: number, typeName: string, size: IRExpr): IRArrayNewDefault =>
    ({ kind: 'ArrayNewDefault', wasmType: 'i32', typeIdx, typeName, size })

const arrayGet = (typeIdx: number, typeName: string, target: IRExpr, idx: IRExpr, et: WasmValType): IRArrayGet =>
    ({ kind: 'ArrayGet', wasmType: et, typeIdx, typeName, target, idx })

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

interface RefSlotSpec { slot: 'result' | number; typeIdx: number }
type LocalSpec = [string, WasmValType] | [string, WasmValType, number /* refTypeIdx */]

function gcFn(
    name: string,
    params: Array<[string, WasmValType]>,
    returnType: WasmValType | 'void',
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
            if (refIdx !== undefined) local.refType = { localTypeIdx: refIdx, nullable: false }
            return local
        }),
        body,
    }
    for (const r of refSlots) {
        const slot = { localTypeIdx: r.typeIdx, nullable: false }
        if (r.slot === 'result') fn.refResult = slot
        else { if (!fn.refParams) fn.refParams = new Map(); fn.refParams.set(r.slot, slot) }
    }
    return fn
}

// ── Registration + per-element function generation ──────────────────────

/** Register $Array_<elem> and $Vec_<elem> (array first — WasmGC forward-ref
 *  rule requires the lower index).  Idempotent (internNominal is name-keyed). */
function registerTypes(reg: WasmGcTypeRegistry, s: ElemSpec): { arrayIdx: number; vecIdx: number } {
    const arrayIdx = reg.internNominal({
        name: s.arrayName,
        spec: { kind: 'array', element: { storage: { kind: 'val', type: s.elem }, mutable: true } },
    })
    const vecIdx = reg.internNominal({
        name: s.vecName,
        spec: { kind: 'struct', fields: [
            { storage: { kind: 'val', type: 'i32' }, mutable: true },                          // len
            { storage: { kind: 'ref', typeIdx: arrayIdx, nullable: false }, mutable: true },    // data
        ] },
    })
    return { arrayIdx, vecIdx }
}

/** The i32-only public registration kept for callers that pre-register the
 *  Vec types before user lowering (lower.ts pre-scan). */
export function registerGcVecTypes(reg: WasmGcTypeRegistry): { arrayIdx: number; vecIdx: number } {
    return registerTypes(reg, SPECS.i32)
}

/** Emit the seven vec_* functions for one element type. */
function buildVecForElem(reg: WasmGcTypeRegistry, s: ElemSpec): IRFunction[] {
    const { arrayIdx, vecIdx } = registerTypes(reg, s)
    const A = s.arrayName, V = s.vecName, et = s.elem
    const vecRef = { slot: 0 as const, typeIdx: vecIdx }

    // new(cap) → struct.new $Vec (0) (array.new_default $Array cap)
    const fnNew = gcFn(s.fn.new, [['cap', i32]], i32, [],
        structNew(vecIdx, V, [c(0), arrayNewDefault(arrayIdx, A, lg('cap'))]),
        [{ slot: 'result', typeIdx: vecIdx }])

    // len(v) → struct.get $Vec 0 v
    const fnLen = gcFn(s.fn.len, [['v', i32]], i32, [], structGet(vecIdx, V, 0, lg('v')), [vecRef])

    // capacity(v) → array.len (struct.get $Vec 1 v)
    const fnCap = gcFn(s.fn.cap, [['v', i32]], i32, [], arrayLen(structGet(vecIdx, V, 1, lg('v'))), [vecRef])

    // get(v, i) → array.get $Array (struct.get $Vec 1 v) i   (result et)
    const fnGet = gcFn(s.fn.get, [['v', i32], ['i', i32]], et, [],
        arrayGet(arrayIdx, A, structGet(vecIdx, V, 1, lg('v')), lg('i'), et), [vecRef])

    // set(v, i, x) → array.set $Array (struct.get $Vec 1 v) i x
    const fnSet = gcFn(s.fn.set, [['v', i32], ['i', i32], ['x', et]], void_, [],
        block([stmt(arraySet(arrayIdx, A, structGet(vecIdx, V, 1, lg('v')), lg('i'), lg('x', et)))]), [vecRef])

    // push(v, x): grow on len>=cap, then array.set + len++
    const v = lg('v')
    const growBody = block([
        ls('new_cap', iif(binop('i32_eq', lg('cap'), c(0)), c(4), binop('i32_mul', lg('cap'), c(2)))),
        ls('new_data', arrayNewDefault(arrayIdx, A, lg('new_cap'))),
        stmt(arrayCopy(arrayIdx, A, lg('new_data'), c(0), structGet(vecIdx, V, 1, v), c(0), lg('len'))),
        stmt(structSet(vecIdx, V, 1, v, lg('new_data'))),
    ])
    const fnPush = gcFn(s.fn.push, [['v', i32], ['x', et]], void_,
        [['len', i32], ['cap', i32], ['new_cap', i32], ['new_data', i32, arrayIdx]],
        block([
            ls('len', structGet(vecIdx, V, 0, v)),
            ls('cap', arrayLen(structGet(vecIdx, V, 1, v))),
            stmt(iif(binop('i32_ge_s', lg('len'), lg('cap')), growBody)),
            stmt(arraySet(arrayIdx, A, structGet(vecIdx, V, 1, v), lg('len'), lg('x', et))),
            stmt(structSet(vecIdx, V, 0, v, binop('i32_add', lg('len'), c(1)))),
        ]), [vecRef])

    // pop(v) → read [len-1], len--, return it
    const fnPop = gcFn(s.fn.pop, [['v', i32]], et, [['len', i32], ['val', et]],
        block([
            ls('len', structGet(vecIdx, V, 0, v)),
            ls('val', arrayGet(arrayIdx, A, structGet(vecIdx, V, 1, v), binop('i32_sub', lg('len'), c(1)), et)),
            stmt(structSet(vecIdx, V, 0, v, binop('i32_sub', lg('len'), c(1)))),
        ], lg('val', et)), [vecRef])

    return [fnNew, fnLen, fnCap, fnGet, fnSet, fnPush, fnPop]
}

// ── Public injection point ──────────────────────────────────────────────

/** Register the Vec types + emit the vec_* functions.  `i32` is always
 *  emitted (byte-identical to the historical output); `extraElems` adds the
 *  Float/Int64 monomorphs a program actually uses.  Caller (lowerProgram
 *  under target='wasm-gc') unshifts these before user-emitted functions. */
export function buildGcVecExtension(
    reg: WasmGcTypeRegistry,
    extraElems: Array<'f32' | 'i64'> = [],
): IRFunction[] {
    const out = buildVecForElem(reg, SPECS.i32)
    for (const e of extraElems) out.push(...buildVecForElem(reg, SPECS[e]))
    return out
}
