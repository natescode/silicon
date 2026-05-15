export enum StrataType {
    Keyword,
    Operator,
    Control,
    /**
     * Definition-kind strata: drive how a definition keyword (@let, @fn, @var,
     * @extern, @type_*) is elaborated and lowered. Not to be confused with
     * code-generation optimisation hooks — that role is reserved for a future
     * StrataType.Codegen variant.
     */
    Definition,
    /** Type-constrained overload of an operator or keyword for a specific operand type. */
    Constraint,
    /**
     * Metadata strata: attach non-value-producing annotations to definitions
     * (@export, @test, @doc). Elaborated by the IR lowerer into module-level
     * directives rather than code-generating constructs.
     */
    Metadata,
}

import { type TypeSig } from '../types/intrinsicSig'

/**
 * Typed payload stored in a StrataNode after the loader has processed
 * the strata body. The raw body AST is NOT stored here — only the derived
 * data that downstream phases (codegen, type checker) actually need.
 */
export interface StrataData {
    /** The parameter name used to refer to the operator node (e.g. "Node"). */
    nodeParamName: string
    /** Full WASM intrinsic name extracted from the body (e.g. "WASM::i32_add"). */
    intrinsic?: string
    /**
     * Ordered steps extracted from the strata body. Each step is either:
     *   - a WASM/IR intrinsic call  ({ intrinsic, argRefs })
     *   - a Silicon function call   ({ userFunc, argRefs })
     *
     * Codegen emits steps in sequence. WASM steps emit inline instructions;
     * userFunc steps emit (call $name args). Steps with no argRefs consume
     * whatever is already on the WAT operand stack.
     */
    bodyTemplate?: Array<{
        intrinsic?: string
        userFunc?: string
        argRefs: Array<'left' | 'right' | 'unknown'>
    }>
    /**
     * Type signature derived at strata-load time. Populated by the strata loader
     * from the WASM intrinsic name (or, in the future, from an explicit
     * declaration in the strata body). The type checker reads this field directly
     * instead of re-deriving from the intrinsic name on every call.
     */
    typeSignature?: TypeSig
}

export interface StrataNode {
    type: StrataType
    discriminant: string
    data?: StrataData
    sourceLocation?: SourceLocation
}

export interface SourceLocation {
    start: number
    end: number
}


/**
 * Derive the correct StrataType from a WASM intrinsic name and the syntactic
 * kind of the strata definition (operator vs keyword).
 *
 * Naming conventions used:
 *   WASM::control_*          → StrataType.Control    (if, loop, match, break, return, …)
 *   IR::def_*                → StrataType.Definition  (let, fn, var, extern, local, type_*)
 *   IR::meta_*               → StrataType.Metadata    (export, test, doc, …)
 *   WASM::i32_* / WASM::f32_* → StrataType.Operator
 *   (no intrinsic)           → falls back to syntactic kind
 */
export function strataTypeFromIntrinsic(
    intrinsic: string | undefined,
    kind: 'operator' | 'keyword',
): StrataType {
    if (intrinsic) {
        if (/^WASM::control_/.test(intrinsic)) return StrataType.Control
        if (/^IR::def_/.test(intrinsic))        return StrataType.Definition
        if (/^IR::meta_/.test(intrinsic))       return StrataType.Metadata
        if (/^WASM::(i32|f32)_/.test(intrinsic)) return StrataType.Operator
    }
    return kind === 'operator' ? StrataType.Operator : StrataType.Keyword
}