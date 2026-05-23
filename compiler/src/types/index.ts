/**
 * Silicon Type System — Public Module Entrypoint
 *
 * Stage 2.6 of the compilation pipeline. Runs after elaboration and before
 * codegen. Attaches `inferredType: SiliconType` to every expression node and
 * reports structured type errors.
 *
 * @see types.ts        - SiliconType definitions and WASM mapping
 * @see typechecker.ts  - The pass itself
 * @see errors.ts       - TypeError shape and factories
 */

export {
    type SiliconType,
    type WasmType,
    TypeInt,
    TypeFloat,
    TypeString,
    TypeBool,
    TypeUnknown,
    ArrayOf,
    FunctionOf,
    wasmTypeOf,
    typeEquals,
    formatType,
    parseTypeName,
    isNumeric,
    isComparable,
    isEqualityComparable,
} from './types'

export {
    type TypeError,
    type TypeErrorKind,
    mismatch,
    invalidOperator,
    unbound,
    unknownType,
    heterogeneousArray,
    annotationMismatch,
    immutableAssignment,
    formatTypeError,
} from './errors'

export { default as typecheck, type TypeCheckResult, type FunctionSig } from './typechecker'
export { intrinsicSignature, type TypeSig } from './intrinsicSig'
