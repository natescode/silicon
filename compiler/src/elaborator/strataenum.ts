export enum StrataType {
    Keyword,
    Constraint,
    Type,
    Capability,
    Operator,
    Control,
    Runtime,
    Codegen,
    Metadata,
    DSL
}

export interface StrataNode {
    type: StrataType
    discriminant: string
    data?: any
    sourceLocation?: SourceLocation
}

export interface SourceLocation {
    start: number
    end: number
}


function createStrataNode(type: StrataType, discriminant: string, data?: any, sourceLocation?: SourceLocation): StrataNode {
    return { type, discriminant, data, sourceLocation }
}

export function createOperatorNode(op: string, left: any, right: any): StrataNode {
    return createStrataNode(StrataType.Operator, op, { left, right })
}

export function createKeywordNode(value: string, sourceLocation?: SourceLocation): StrataNode {
    return createStrataNode(StrataType.Keyword, value, sourceLocation)
}

/**
 * Derive the correct StrataType from a WASM intrinsic name and the syntactic
 * kind of the strata definition (operator vs keyword).
 *
 * Naming conventions used:
 *   WASM::control_*  → StrataType.Control   (if, loop, match)
 *   WASM::def_*      → StrataType.Codegen   (let, fn, var, extern, local, type_*)
 *   WASM::i32_* / WASM::f32_* → StrataType.Operator
 *   (no intrinsic)   → falls back to syntactic kind
 */
export function strataTypeFromIntrinsic(
    intrinsic: string | undefined,
    kind: 'operator' | 'keyword',
): StrataType {
    if (intrinsic) {
        if (/^WASM::control_/.test(intrinsic)) return StrataType.Control
        if (/^WASM::def_/.test(intrinsic)) return StrataType.Codegen
        if (/^WASM::(i32|f32)_/.test(intrinsic)) return StrataType.Operator
    }
    return kind === 'operator' ? StrataType.Operator : StrataType.Keyword
}