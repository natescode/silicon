// SPDX-License-Identifier: MIT
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
    | 'MissingReturn'         // Non-void function body does not produce a value
    | 'ArityMismatch'         // Wrong number of arguments at a call site
    | 'MvpOnlyIntrospection'  // Phase 9d-5a (E0012) — &rc_count, &heap_used, …
    | 'MvpOnlyPhysicalByte'   // Phase 9d-5b (E0013) — &alloc, &str_ptr, …
    | 'GlobalInFunction'      // @global used inside a function body (E0014)
    | 'MissingParamType'      // function has parameters but no signature line (E0015)
    | 'AwaitOutsideAsync'     // @await used outside an @async function body (E0016)
    | 'CapDeriveNonRoot'      // @cap_derive on a non-root capability (ADR 0027, E0017)

export interface TypeError {
    kind: TypeErrorKind
    message: string
    sourceLocation?: SourceLocation
    /** Optional secondary advice surfaced as hint in the rendered Diagnostic. */
    hint?: string
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
 * Factory — `@global` used inside a function body.  `@global` is a top-level,
 * module-scoped immutable binding; written in a function it would hoist to
 * module scope and the local reference would fail at codegen.  Inside a
 * function the binding is `@local`.
 */
export function globalInFunction(name: string, sourceLocation?: SourceLocation): TypeError {
    return {
        kind: 'GlobalInFunction',
        message: `'@global ${name}' is a top-level binding — use '@local ${name}' inside a function body`,
        sourceLocation,
        hint: `@global declares a module-scoped constant; @local declares a function-local`,
    }
}

/**
 * Factory — a function parameter's type could not be inferred. ADR-0020 makes
 * signatures optional: an unannotated parameter's type is inferred *monomorphically*
 * from the function's call sites — it must resolve to one concrete type across all
 * of them. This is inference, NOT monomorphization: no per-call-site specialization
 * happens, so a function used at two different concrete types is rejected rather
 * than specialized. Reaching here means that single-type inference failed — the
 * function has no call sites with concrete arguments, or its call sites disagree on
 * a concrete type (genuinely polymorphic). Fixes: annotate the parameter, add a
 * `\\` signature line, or — for a genuinely polymorphic function — make it `[T]`.
 */
/**
 * Factory — `@await` used outside an `@async` function (ADR 0018 §2.2 coloring).
 * `@await` marks a suspension point, which only an `@async`-colored function may
 * contain; the color propagates up the call graph (and is exactly the set the
 * Asyncify route-B transform instruments).  Mark the enclosing `@fn` `@async`.
 */
export function awaitOutsideAsync(sourceLocation?: SourceLocation): TypeError {
    return {
        kind: 'AwaitOutsideAsync',
        message: `'@await' may only appear inside an '@async' function`,
        sourceLocation,
        hint: `mark the enclosing function '@async' on its \\\\ signature line: \\\\ @async name (…) -> …`,
    }
}

export function capDeriveNonRoot(got: SiliconType, sourceLocation?: SourceLocation): TypeError {
    return {
        kind: 'CapDeriveNonRoot',
        message: `'@cap_derive' may only attenuate the root capability 'World', not '${formatType(got)}'`,
        sourceLocation,
        hint: `derive domain capabilities from the root passed to 'main' (\\\\ @fn main (World) -> Int); a cap can't be forged from a literal or amplified from another domain cap`,
    }
}

export function missingParamType(param: string, fn: string, sourceLocation?: SourceLocation): TypeError {
    return {
        kind: 'MissingParamType',
        message: `could not monomorphically infer the type of parameter '${param}' of '${fn}'`,
        sourceLocation,
        hint: `monomorphic inference needs one concrete type for '${param}' across every call site — '${fn}' has none with concrete arguments, or its call sites disagree; annotate the parameter, add a \`\\\\ ${fn} (Type, …) -> Ret\` signature, or make it generic with \`[T]\``,
    }
}

/**
 * Factory — wrong number of arguments at a call site.
 */
export function arityMismatch(
    name: string,
    expected: number,
    actual: number,
    sourceLocation?: SourceLocation,
    hint?: string,
): TypeError {
    return {
        kind: 'ArityMismatch',
        message: `'${name}' expects ${expected} argument(s), got ${actual}`,
        sourceLocation,
        hint,
    }
}

/**
 * Factory — non-void function body does not produce a value on all paths.
 */
export function missingReturn(
    name: string,
    declared: SiliconType,
    sourceLocation?: SourceLocation,
): TypeError {
    return {
        kind: 'MissingReturn',
        message: `'${name}' is declared to return ${formatType(declared)} but body may not produce a value`,
        sourceLocation,
    }
}

/**
 * Phase 9d-5a (E0012) — call to an introspection primitive
 * (`&rc_count`, `&rc_is_unique`, `&heap_used`, `&arena_used`,
 * `&heap_get`, `&heap_set`) under `--target=wasm-gc`.  These
 * primitives have no honest wasm-gc semantics — conservative no-op
 * values would silently change branch behavior (e.g.,
 * `&@if (&rc_count r) > 5, { panic }`).  See ADR 0009 §2.
 */
export function mvpOnlyIntrospection(
    name: string,
    sourceLocation?: SourceLocation,
): TypeError {
    return {
        kind: 'MvpOnlyIntrospection',
        message: `'${name}' is a wasm-mvp-only introspection primitive; it has no honest wasm-gc semantics`,
        sourceLocation,
        hint: `compile with --target=wasm-mvp, or remove the introspection (managed refs are implicitly shared so refcount inspection is moot under GC)`,
    }
}

/**
 * Phase 9d-5b (E0013) — call to a physical-byte primitive
 * (`&alloc`, `&realloc`, `&mem_copy`, `&str_ptr`) under
 * `--target=wasm-gc`.  Managed references aren't addressable —
 * `(ref $T)` has no stable integer address.  See ADR 0009 §2.
 */
export function mvpOnlyPhysicalByte(
    name: string,
    sourceLocation?: SourceLocation,
): TypeError {
    return {
        kind: 'MvpOnlyPhysicalByte',
        message: `'${name}' is a wasm-mvp-only raw-memory primitive; managed refs aren't addressable under wasm-gc`,
        sourceLocation,
        hint: `compile with --target=wasm-mvp, or use the managed stdlib equivalent (e.g. (ref $String) instead of &str_ptr)`,
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
