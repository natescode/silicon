/**
 * Abstract Syntax Tree Node Definitions
 *
 * This module defines all the TypeScript interfaces and types that make up the
 * Silicon Abstract Syntax Tree (AST). The AST is a strongly-typed representation
 * of Silicon programs that preserves semantic information.
 *
 * Design decisions:
 * - All nodes have a discriminating `type` field for safe pattern matching
 * - Complex nodes use a `kind` field to distinguish between variants
 * - Optional `sourceLocation` for error reporting and debugging
 * - Factory functions (ASTFactory) ensure consistent node creation
 *
 * @see toAst.ts - Converts parse trees to AST nodes
 * @see compile.ts - Transforms AST nodes into WebAssembly
 */

export type ASTNode =
    | Program
    | Element
    | Item
    | Statement
    | Assignment
    | Definition
    | ExpressionStart
    | BinOp
    | FunctionCall
    | ExpressionEnd
    | Literal
    | ArrayLiteral
    | ObjectLiteral
    | TupleLiteral
    | StringLiteral
    | IntLiteral
    | FloatLiteral
    | BooleanLiteral
    | KeyValuePair
    | Block
    | Binding
    | Namespace
    | TypeAnnotation
    | Parameter
    | GenericParams
    | DocComment

export interface Program {
    type: 'Program'
    elements: Element[]
    sourceLocation?: SourceLocation
}

export interface Element {
    type: 'Element'
    kind: 'item' | 'docComment'
    value: Item | DocComment
    sourceLocation?: SourceLocation
}

export interface Item {
    type: 'Item'
    kind: 'statement' | 'expression'
    value: Statement | ExpressionStart
    sourceLocation?: SourceLocation
}

export interface DocComment {
    type: 'DocComment'
    content: string
    sourceLocation?: SourceLocation
}

export interface Statement {
    type: 'Statement'
    kind: 'assignment' | 'definition'
    value: Assignment | Definition
    sourceLocation?: SourceLocation
}

export interface Assignment {
    type: 'Assignment'
    target: Namespace
    value: ExpressionStart
    sourceLocation?: SourceLocation
}

export interface Definition {
    type: 'Definition'
    keyword: string // '@let', '@fn', '@when', etc.
    name: TypedIdentifier
    generics?: GenericParams
    params: Parameter[]
    binding?: Binding
    sourceLocation?: SourceLocation
}

export interface ExpressionStart {
    type: 'ExpressionStart'
    kind: 'binOp' | 'functionCall' | 'expressionEnd'
    value: BinOp | FunctionCall | ExpressionEnd
    sourceLocation?: SourceLocation
}

export interface BinOp {
    type: 'BinOp'
    left: ExpressionStart
    operator: string
    right: ExpressionEnd
    sourceLocation?: SourceLocation
}

export interface FunctionCall {
    type: 'FunctionCall'
    name: string | Namespace // keyword or user function
    isBuiltin: boolean
    args: ExpressionStart[]
    sourceLocation?: SourceLocation
}

export interface ExpressionEnd {
    type: 'ExpressionEnd'
    kind: 'literal' | 'namespace' | 'block' | 'paren'
    value: Literal | Namespace | Block | ExpressionStart
    sourceLocation?: SourceLocation
}

export interface Literal {
    type: 'Literal'
    kind: 'array' | 'object' | 'tuple' | 'string' | 'int' | 'float' | 'boolean'
    value: ArrayLiteral | ObjectLiteral | TupleLiteral | StringLiteral | IntLiteral | FloatLiteral | BooleanLiteral
    sourceLocation?: SourceLocation
}

export interface ArrayLiteral {
    type: 'ArrayLiteral'
    elements: ExpressionStart[]
    sourceLocation?: SourceLocation
}

export interface ObjectLiteral {
    type: 'ObjectLiteral'
    properties: KeyValuePair[]
    sourceLocation?: SourceLocation
}

export interface TupleLiteral {
    type: 'TupleLiteral'
    elements: ExpressionStart[]
    sourceLocation?: SourceLocation
}

export interface StringLiteral {
    type: 'StringLiteral'
    value: string
    sourceLocation?: SourceLocation
}

export interface IntLiteral {
    type: 'IntLiteral'
    value: string // Keep as string to preserve base (binary, hex, octal)
    base: 'decimal' | 'binary' | 'hexadecimal' | 'octal'
    sourceLocation?: SourceLocation
}

export interface FloatLiteral {
    type: 'FloatLiteral'
    value: number
    sourceLocation?: SourceLocation
}

export interface BooleanLiteral {
    type: 'BooleanLiteral'
    value: boolean
    sourceLocation?: SourceLocation
}

export interface KeyValuePair {
    type: 'KeyValuePair'
    key: TypedIdentifier
    value: ExpressionStart
    sourceLocation?: SourceLocation
}

export interface Block {
    type: 'Block'
    items: Item[]
    sourceLocation?: SourceLocation
}

export interface Binding {
    type: 'Binding'
    expression: ExpressionEnd
    sourceLocation?: SourceLocation
}

export interface Namespace {
    type: 'Namespace'
    path: string[] // ['module', 'submodule', 'identifier']
    sourceLocation?: SourceLocation
}

export interface TypedIdentifier {
    type: 'TypedIdentifier'
    name: string
    typeAnnotation?: TypeAnnotation
    sourceLocation?: SourceLocation
}

export interface TypeAnnotation {
    type: 'TypeAnnotation'
    typename: string
    sourceLocation?: SourceLocation
}

export interface Parameter {
    type: 'Parameter'
    name: string
    typeAnnotation?: TypeAnnotation
    isLiteral: boolean // false for TypedIdentifier, true for Literal
    value?: Literal
    sourceLocation?: SourceLocation
}

export interface GenericParams {
    type: 'GenericParams'
    params: string[]
    sourceLocation?: SourceLocation
}

export interface SourceLocation {
    startLine: number
    startColumn: number
    endLine: number
    endColumn: number
}

// Factory functions for creating AST nodes
export const ASTFactory = {
    program(elements: Element[]): Program {
        return { type: 'Program', elements }
    },

    element(kind: 'item' | 'docComment', value: Item | DocComment): Element {
        return { type: 'Element', kind, value }
    },

    item(kind: 'statement' | 'expression', value: Statement | ExpressionStart): Item {
        return { type: 'Item', kind, value }
    },

    docComment(content: string): DocComment {
        return { type: 'DocComment', content }
    },

    statement(kind: 'assignment' | 'definition', value: Assignment | Definition): Statement {
        return { type: 'Statement', kind, value }
    },

    assignment(target: Namespace, value: ExpressionStart): Assignment {
        return { type: 'Assignment', target, value }
    },

    definition(
        keyword: string,
        name: TypedIdentifier,
        params: Parameter[],
        generics?: GenericParams,
        binding?: Binding
    ): Definition {
        return { type: 'Definition', keyword, name, generics, params, binding }
    },

    expressionStart(kind: 'binOp' | 'functionCall' | 'expressionEnd', value: BinOp | FunctionCall | ExpressionEnd): ExpressionStart {
        return { type: 'ExpressionStart', kind, value }
    },

    binOp(left: ExpressionStart, operator: string, right: ExpressionEnd): BinOp {
        return { type: 'BinOp', left, operator, right }
    },

    functionCall(name: string | Namespace, isBuiltin: boolean, args: ExpressionStart[]): FunctionCall {
        return { type: 'FunctionCall', name, isBuiltin, args }
    },

    expressionEnd(kind: 'literal' | 'namespace' | 'block' | 'paren', value: Literal | Namespace | Block | ExpressionStart): ExpressionEnd {
        return { type: 'ExpressionEnd', kind, value }
    },

    literal(kind: string, value: any): Literal {
        return { type: 'Literal', kind: kind as any, value }
    },

    arrayLiteral(elements: ExpressionStart[]): ArrayLiteral {
        return { type: 'ArrayLiteral', elements }
    },

    objectLiteral(properties: KeyValuePair[]): ObjectLiteral {
        return { type: 'ObjectLiteral', properties }
    },

    tupleLiteral(elements: ExpressionStart[]): TupleLiteral {
        return { type: 'TupleLiteral', elements }
    },

    stringLiteral(value: string): StringLiteral {
        return { type: 'StringLiteral', value }
    },

    intLiteral(value: string, base: 'decimal' | 'binary' | 'hexadecimal' | 'octal'): IntLiteral {
        return { type: 'IntLiteral', value, base }
    },

    floatLiteral(value: number): FloatLiteral {
        return { type: 'FloatLiteral', value }
    },

    booleanLiteral(value: boolean): BooleanLiteral {
        return { type: 'BooleanLiteral', value }
    },

    keyValuePair(key: TypedIdentifier, value: ExpressionStart): KeyValuePair {
        return { type: 'KeyValuePair', key, value }
    },

    block(items: Item[]): Block {
        return { type: 'Block', items }
    },

    binding(expression: ExpressionEnd): Binding {
        return { type: 'Binding', expression }
    },

    namespace(path: string[]): Namespace {
        return { type: 'Namespace', path }
    },

    typedIdentifier(name: string, typeAnnotation?: TypeAnnotation): TypedIdentifier {
        return { type: 'TypedIdentifier', name, typeAnnotation }
    },

    typeAnnotation(typename: string): TypeAnnotation {
        return { type: 'TypeAnnotation', typename }
    },

    parameter(name: string, typeAnnotation?: TypeAnnotation, isLiteral?: boolean, value?: Literal): Parameter {
        return { type: 'Parameter', name, typeAnnotation, isLiteral: isLiteral || false, value }
    },

    genericParams(params: string[]): GenericParams {
        return { type: 'GenericParams', params }
    },

    sourceLocation(startLine: number, startColumn: number, endLine: number, endColumn: number): SourceLocation {
        return { startLine, startColumn, endLine, endColumn }
    }
}
