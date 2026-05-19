/**
 * Type-system Diagnostics
 *
 * Structured error records produced by the type checker. Keeping them as plain
 * data (rather than throwing) lets the checker collect every problem in one
 * pass instead of bailing on the first mismatch, which is far more useful when
 * developing.
 *
 * Call sites usually accumulate `TypeError`s in the `TypeCheckContext`, then
 * decide at the end of the pass whether to throw, log, or hand them to a
 * language-server-style diagnostics channel.
 */

import type { SourceLocation } from '../ast/astNodes'
import type { SiliconType } from './types'
import { formatType } from './types'

/**
 * Categorises what went wrong. Useful for filtering in tests and for IDE-style
 * code actions.
 */
export type TypeErrorKind =
    | 'UnknownType'           // Type annotation referenced an unrecognised name
    | 'Mismatch'              // Expected type X, got type Y
    | 'InvalidOperator'       // Operator is not defined for these operand types
    | 'UnboundIdentifier'     // Reference to an unknown identifier
    | 'HeterogeneousArray'    // Array literal elements do not all share a type
    | 'Annotation'            // Initializer doesn't match declared annotation
    | 'ImmutableAssignment'   // Assignment to an immutable binding (@let, @fn, @extern)

export interface TypeError {
    kind: TypeErrorKind
    message: string
    sourceLocation?: SourceLocation
}

/**
 * Factory — "expected T, got U". The most common error in a type checker, so
 * it gets its own helper.
 */
export function mismatch(
    expected: SiliconType,
    actual: SiliconType,
    context: string,
    sourceLocation?: SourceLocation
): TypeError {
    return {
        kind: 'Mismatch',
        message: `${context}: expected ${formatType(expected)}, got ${formatType(actual)}`,
        sourceLocation,
    }
}

/**
 * Factory — "operator + cannot be applied to (String, Int)".
 */
export function invalidOperator(
    op: string,
    left: SiliconType,
    right: SiliconType,
    sourceLocation?: SourceLocation
): TypeError {
    return {
        kind: 'InvalidOperator',
        message: `operator '${op}' cannot be applied to (${formatType(left)}, ${formatType(right)})`,
        sourceLocation,
    }
}

/**
 * Factory — reference to an unknown identifier.
 */
export function unbound(name: string, sourceLocation?: SourceLocation): TypeError {
    return {
        kind: 'UnboundIdentifier',
        message: `unbound identifier '${name}'`,
        sourceLocation,
    }
}

/**
 * Factory — unrecognised type annotation.
 */
export function unknownType(name: string, sourceLocation?: SourceLocation): TypeError {
    return {
        kind: 'UnknownType',
        message: `unknown type '${name}'`,
        sourceLocation,
    }
}

/**
 * Factory — array literal with mixed element types.
 */
export function heterogeneousArray(
    first: SiliconType,
    other: SiliconType,
    sourceLocation?: SourceLocation
): TypeError {
    return {
        kind: 'HeterogeneousArray',
        message: `array literal must be homogeneous: first element is ${formatType(first)}, found ${formatType(other)}`,
        sourceLocation,
    }
}

/**
 * Factory — value assigned doesn't match a declared type annotation.
 */
export function annotationMismatch(
    name: string,
    annotated: SiliconType,
    actual: SiliconType,
    sourceLocation?: SourceLocation
): TypeError {
    return {
        kind: 'Annotation',
        message: `'${name}' declared as ${formatType(annotated)} but initialiser has type ${formatType(actual)}`,
        sourceLocation,
    }
}

/**
 * Factory — assignment to a binding that cannot be mutated.
 */
export function immutableAssignment(name: string, sourceLocation?: SourceLocation): TypeError {
    return {
        kind: 'ImmutableAssignment',
        message: `'${name}' is immutable and cannot be reassigned`,
        sourceLocation,
    }
}

/**
 * Render a TypeError to a single-line human-readable string. Includes source
 * location if available.
 */
export function formatTypeError(err: TypeError): string {
    if (err.sourceLocation) {
        const { startLine, startColumn } = err.sourceLocation
        return `[${err.kind}] ${startLine}:${startColumn}: ${err.message}`
    }
    return `[${err.kind}] ${err.message}`
}
