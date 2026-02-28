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
    return { type, discriminant, sourceLocation }
}

export function createOperatorNode(op: string, left: any, right: any): StrataNode {
    return createStrataNode(StrataType.Operator, op, { left, right })
}

export function createKeywordNode(value: string, sourceLocation?: SourceLocation): StrataNode {
    return createStrataNode(StrataType.Keyword, value, sourceLocation)
}