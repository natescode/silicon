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

import { type SiliconType, TypeInt, TypeFloat, TypeBool, TypeUnknown } from './types'

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
 * Derive a TypeSig from a WASM intrinsic name. Returns undefined when the
 * name is not recognised (e.g. control-flow ops that have no surface type).
 */
export function intrinsicSignature(fullName: string): TypeSig | undefined {
    const m = fullName.match(/^WASM::(.+)$/)
    if (!m) return undefined
    const short = m[1]

    // Binary arithmetic / bitwise / comparison: <type>_<op>
    const binaryOp = /^(i32|f32)_(add|sub|mul|div(_[su])?|rem(_[su])?|and|or|xor|shl|shr_s|shr_u|rotl|rotr|eq|ne|lt(_[su])?|gt(_[su])?|le(_[su])?|ge(_[su])?)$/
    if (binaryOp.test(short)) {
        const prefix = short.startsWith('i32') ? TypeInt : TypeFloat
        const isComp = /^(eq|ne|lt|gt|le|ge)(_[su])?$/.test(short.slice(4))
        return { params: [prefix, prefix], result: isComp ? TypeBool : prefix }
    }

    // Unary ops.
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

    // Memory ops.
    if (short === 'i32_load' || short === 'i32_load8_s' || short === 'i32_load8_u') {
        return { params: [TypeInt], result: TypeInt }
    }
    if (short === 'f32_load') {
        return { params: [TypeInt], result: TypeFloat }
    }
    if (short === 'i32_store' || short === 'i32_store8') {
        return { params: [TypeInt, TypeInt], result: TypeUnknown }
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

    // Control-flow, def, and other structured ops have no surface type sig.
    return undefined
}
