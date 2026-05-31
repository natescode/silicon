// SPDX-License-Identifier: MIT
/**
 * Silicon Type System — Public Module Entrypoint
 *
 * Stage 2.6 of the compilation pipeline. Runs after elaboration and before
 * codegen. Builds a SemanticModel (CaaS-2) alongside type-annotating the AST.
 *
 * @see types.ts        - SiliconType definitions and WASM mapping
 * @see typechecker.ts  - The pass itself
 * @see errors.ts       - TypeError shape and factories
 * @see ../ast/semanticModel.ts - SemanticModel (CaaS-2)
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
export { SemanticModel, type Symbol as CaaSSymbol, type SymbolKind, type SourceRange } from '../ast/semanticModel'
