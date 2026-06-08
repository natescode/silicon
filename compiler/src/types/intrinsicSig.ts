// SPDX-License-Identifier: MIT
/**
 * Intrinsic Signature Derivation
 *
 * Maps WASM intrinsic names to their Silicon-level type signatures.
 * Shared between the strata loader (which stores signatures at load time)
 * and the type checker (which reads them from the registry).
 *
 * The naming convention is highly regular:
 *   WASM::i32_add        → (Int, Int) → Int
 *   WASM::f32_convert_i32_s → (Int) → Float
 * This lets us derive most signatures from the intrinsic name alone, without
 * a hand-written table for every WASM op.
 */

import { type SiliconType, TypeInt, TypeInt64, TypeFloat, TypeBool, TypeUnknown } from './types'

/**
 * Type signature for a strata or WASM intrinsic: param types + result type.
 * Identical in shape to FunctionSig in typechecker.ts — kept separate so
 * strataenum.ts can import it without creating a circular dependency.
 */
export interface TypeSig {
    params: SiliconType[]
    result: SiliconType
}

/**
 * Derive a TypeSig from an intrinsic name (`WASM::foo` or `IR::foo`).
 * Returns undefined when the name is not recognised (e.g. control-flow ops
 * that have no surface type).  IR::foo is treated identically to WASM::foo
 * — both refer to the same underlying instruction with the same type signature.
 */
export function intrinsicSignature(fullName: string): TypeSig | undefined {
    const m = fullName.match(/^(?:WASM|IR)::(.+)$/)
    if (!m) return undefined
    const short = m[1]

    // Binary arithmetic / bitwise / comparison: <type>_<op>
    const binaryOp = /^(i32|i64|f32)_(add|sub|mul|div(_[su])?|rem(_[su])?|and|or|xor|shl|shr_s|shr_u|rotl|rotr|eq|ne|lt(_[su])?|gt(_[su])?|le(_[su])?|ge(_[su])?)$/
    if (binaryOp.test(short)) {
        const prefix = short.startsWith('i32') ? TypeInt
            : short.startsWith('i64') ? TypeInt64
            : TypeFloat
        const isComp = /^(eq|ne|lt|gt|le|ge)(_[su])?$/.test(short.slice(4))
        return { params: [prefix, prefix], result: isComp ? TypeBool : prefix }
    }

    // Unary ops.
    // Note: i32_eqz / i64_eqz are intentionally excluded — at the Silicon
    // level @not must accept both Bool and Int operands, but the type system
    // treats them as distinct types. Giving eqz a typed signature would
    // reject `@not @true` (Bool arg) when the signature says Int. The
    // stratum stays untyped so lookupTypedKeyword falls back to the plain
    // entry for both operand kinds.
    const unaryI32 = ['clz', 'ctz', 'popcnt']
    if (short.startsWith('i32_') && unaryI32.includes(short.slice(4))) {
        return { params: [TypeInt], result: TypeInt }
    }
    const unaryF32 = ['abs', 'neg', 'sqrt']
    if (short.startsWith('f32_') && unaryF32.includes(short.slice(4))) {
        return { params: [TypeFloat], result: TypeFloat }
    }

    // Conversions.
    if (short === 'i32_trunc_f32_s' || short === 'i32_trunc_f32_u') {
        return { params: [TypeFloat], result: TypeInt }
    }
    if (short === 'f32_convert_i32_s' || short === 'f32_convert_i32_u') {
        return { params: [TypeInt], result: TypeFloat }
    }
    if (short === 'i64_extend_i32_s' || short === 'i64_extend_i32_u') {
        return { params: [TypeInt], result: TypeInt64 }
    }
    if (short === 'i32_wrap_i64') {
        return { params: [TypeInt64], result: TypeInt }
    }

    // Memory ops.
    if (short === 'i32_load' || short === 'i32_load8_s' || short === 'i32_load8_u') {
        return { params: [TypeInt], result: TypeInt }
    }
    if (short === 'i64_load') {
        return { params: [TypeInt], result: TypeInt64 }
    }
    if (short === 'f32_load') {
        return { params: [TypeInt], result: TypeFloat }
    }
    if (short === 'i32_store' || short === 'i32_store8') {
        return { params: [TypeInt, TypeInt], result: TypeUnknown }
    }
    if (short === 'i64_store') {
        return { params: [TypeInt, TypeInt64], result: TypeUnknown }
    }
    if (short === 'f32_store') {
        return { params: [TypeInt, TypeFloat], result: TypeUnknown }
    }
    if (short === 'data_memory') {
        return { params: [], result: TypeInt }
    }
    if (short === 'mem_grow') {
        return { params: [TypeInt], result: TypeInt }
    }
    // Bulk memory: (dst, src|byte, n) → void.
    if (short === 'memory_copy' || short === 'memory_fill') {
        return { params: [TypeInt, TypeInt, TypeInt], result: TypeUnknown }
    }

    // Control-flow, def, and other structured ops have no surface type sig.
    return undefined
}
