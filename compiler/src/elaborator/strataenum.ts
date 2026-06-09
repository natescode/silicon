// SPDX-License-Identifier: MIT
//
// `StrataType` is a COARSE classification tag, not a dispatch key.  Built-in
// lowering is selected by the registered token + its `on::lower` handler, never
// by StrataType.  The live loader (strataLoader.ts) only ever assigns two of the
// six variants — `Keyword` (every keyword) and `Operator` (every operator); the
// finer variants below (`Control`, `Definition`, `Constraint`, `Metadata`) are
// reserved and currently UNUSED, because `strataTypeFromIntrinsic` (which would
// assign them) is not called on the migrated-strata path (handlers carry no
// intrinsic).  These six map onto the spec's nine conceptual StrataTypes as:
// Operator→Operator, Control→Control, Type→Definition (broader: all def-kinds),
// Constraint→Constraint, Metadata→Metadata; spec Codegen/Runtime/Capability/DSL
// have no enum variant (reserved).  See docs/strata.md for the full table.
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
 * Derive the correct StrataType from an intrinsic name and the syntactic
 * kind of the strata definition (operator vs keyword).
 *
 * NOTE: currently UNUSED by the live loader — built-in strata register via
 * `on::lower` handlers and carry no intrinsic, so the loader tags them
 * `Keyword`/`Operator` directly (see strataLoader.ts).  Retained as the
 * intended classifier for any future intrinsic-bearing strata and exercised
 * by unit tests; the finer tags it returns are informational, not dispatched on.
 *
 * Naming conventions used:
 *   WASM::control_* / IR::control_*  → StrataType.Control    (if, loop, match, break, return, …)
 *   IR::def_*                         → StrataType.Definition  (let, fn, var, extern, local, type_*)
 *   IR::meta_*                        → StrataType.Metadata    (export, test, doc, …)
 *   WASM::i32_* / WASM::f32_*        → StrataType.Operator
 *   IR::i32_* / IR::f32_*            → StrataType.Operator
 *   (no intrinsic)                    → falls back to syntactic kind
 */
export function strataTypeFromIntrinsic(
    intrinsic: string | undefined,
    kind: 'operator' | 'keyword',
): StrataType {
    if (intrinsic) {
        if (/^(WASM|IR)::control_/.test(intrinsic))   return StrataType.Control
        if (/^IR::def_/.test(intrinsic))               return StrataType.Definition
        if (/^IR::meta_/.test(intrinsic))              return StrataType.Metadata
        if (/^(WASM|IR)::(i32|f32)_/.test(intrinsic)) return StrataType.Operator
    }
    return kind === 'operator' ? StrataType.Operator : StrataType.Keyword
}