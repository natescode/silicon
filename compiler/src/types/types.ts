/**
 * Silicon Type System — Core Type Definitions
 *
 * Defines the surface-level types that Silicon exposes to programmers, the
 * WebAssembly value types they lower to, and helpers for comparison and
 * formatting.
 *
 * Design:
 * - Tagged union (`SiliconType`) keeps it easy to add parameterised types
 *   (generics, function types, object types) later without breaking existing
 *   pattern matches.
 * - Every surface type maps to a concrete WASM value type (`WasmType`).
 * - Strict equality: two types are equal only when their tag and all payload
 *   fields match. No implicit coercion is applied anywhere in this module.
 *
 * Surface syntax (grammar already supports `identifier : typename`):
 *   Int, Float, String, Bool, Array[T]
 *
 * WASM lowering:
 *   Int    → i32
 *   Float  → f32
 *   Bool   → i32   (0 = false, 1 = true)
 *   String → i32   (pointer into linear memory; length-prefixed)
 *   Array  → i32   (pointer into linear memory; length-prefixed)
 *
 * The pointer-typed values (String, Array) live on the heap and are allocated
 * via helpers in std.wat. See std.wat for the memory layout details.
 */

/**
 * The Silicon surface type. Every expression in a well-typed Silicon program
 * has exactly one SiliconType.
 */
export type SiliconType =
    | { kind: 'Int' }
    | { kind: 'Float' }
    | { kind: 'String' }
    | { kind: 'Bool' }
    | { kind: 'Array'; element: SiliconType }
    | { kind: 'Function'; params: SiliconType[]; result: SiliconType }
    // A user-defined distinct type. Structurally identical to `underlying` in
    // WASM, but incompatible with it (and with other Distinct types) at the
    // Silicon level. Use `wasmTypeOf` to get the concrete WASM encoding.
    | { kind: 'Distinct'; name: string; underlying: SiliconType }
    // A user-defined sum type. Variants are stored as i32 constants (0, 1, …)
    // and are accessed as `Name::Variant` namespace references.
    | { kind: 'Sum'; name: string; variants: string[] }
    // `Unknown` is the top type used when the checker cannot determine a type
    // (e.g. references to unbound identifiers). It never appears in a
    // well-typed program. Downstream code should treat `Unknown` as "do not
    // propagate further errors from this node".
    | { kind: 'Unknown' }

/**
 * The set of WebAssembly value types Silicon currently targets. `void` is used
 * for expressions that produce no stack value (e.g. prints, stores).
 */
export type WasmType = 'i32' | 'f32' | 'void'

/**
 * Pre-constructed singletons for the common primitive types. Using these
 * avoids allocating a fresh object every time the checker names a type.
 */
export const TypeInt: SiliconType = { kind: 'Int' }
export const TypeFloat: SiliconType = { kind: 'Float' }
export const TypeString: SiliconType = { kind: 'String' }
export const TypeBool: SiliconType = { kind: 'Bool' }
export const TypeUnknown: SiliconType = { kind: 'Unknown' }

/**
 * Construct an Array[T] type.
 */
export function ArrayOf(element: SiliconType): SiliconType {
    return { kind: 'Array', element }
}

/**
 * Construct a Function type. Represents a callable with typed parameters and
 * a typed return value. Lowers to i32 (function index) in WASM.
 */
export function FunctionOf(params: SiliconType[], result: SiliconType): SiliconType {
    return { kind: 'Function', params, result }
}

/**
 * Construct a Distinct type. Shares the WASM encoding of `underlying` but is
 * a separate, incompatible type at the Silicon level. Assigning an `Int` to a
 * variable declared as `age` (distinct from Int) is a type error.
 */
export function DistinctOf(name: string, underlying: SiliconType): SiliconType {
    return { kind: 'Distinct', name, underlying }
}

/**
 * Construct a Sum type. Variants are the names of each constructor
 * (e.g. `['Red', 'Green', 'Blue']` for `Color`). All variants lower to i32
 * constants (0, 1, 2, …) in WAT and are accessed as `Name::Variant`.
 */
export function SumOf(name: string, variants: string[]): SiliconType {
    return { kind: 'Sum', name, variants }
}

/**
 * Map a SiliconType to its WebAssembly value type.
 *
 * This is the single source of truth for the language → WASM lowering. Codegen
 * should call this instead of hard-coding i32/f32 per operator.
 */
export function wasmTypeOf(t: SiliconType): WasmType {
    switch (t.kind) {
        case 'Int':
        case 'Bool':
        case 'String':   // pointer
        case 'Array':    // pointer
        case 'Function': // function table index
            return 'i32'
        case 'Float':
            return 'f32'
        case 'Distinct':
            return wasmTypeOf(t.underlying)
        case 'Sum':
            return 'i32'
        case 'Unknown':
            // Conservative: assume i32 so codegen still emits something plausible
            // when a type error has been reported upstream.
            return 'i32'
    }
}

/**
 * Structural equality on SiliconType. Recurses through Array element types.
 */
export function typeEquals(a: SiliconType, b: SiliconType): boolean {
    if (a.kind !== b.kind) return false
    if (a.kind === 'Array' && b.kind === 'Array') {
        return typeEquals(a.element, b.element)
    }
    if (a.kind === 'Function' && b.kind === 'Function') {
        if (a.params.length !== b.params.length) return false
        for (let i = 0; i < a.params.length; i++) {
            if (!typeEquals(a.params[i], b.params[i])) return false
        }
        return typeEquals(a.result, b.result)
    }
    // Distinct types are equal only to themselves (same name).
    if (a.kind === 'Distinct' && b.kind === 'Distinct') {
        return a.name === b.name
    }
    // Sum types are equal only to themselves (same name).
    if (a.kind === 'Sum' && b.kind === 'Sum') {
        return a.name === b.name
    }
    return true
}

/**
 * Pretty-print a SiliconType using the surface syntax. Useful for error
 * messages and debugging dumps.
 */
export function formatType(t: SiliconType): string {
    switch (t.kind) {
        case 'Int': return 'Int'
        case 'Float': return 'Float'
        case 'String': return 'String'
        case 'Bool': return 'Bool'
        case 'Array': return `Array[${formatType(t.element)}]`
        case 'Function': return `Function(${t.params.map(formatType).join(', ')}) -> ${formatType(t.result)}`
        case 'Distinct': return t.name
        case 'Sum': return `${t.name}(${t.variants.join(' | ')})`
        case 'Unknown': return '<unknown>'
    }
}

/**
 * Parse a surface type annotation (the string from `TypeAnnotation.typename`)
 * into a SiliconType. Returns `undefined` for names this pass does not
 * recognise so the caller can decide how to handle it (e.g. emit a helpful
 * error).
 *
 * Accepted names: `Int`, `Float`, `String`, `Bool`. Generic `Array[T]` is not
 * yet representable in the grammar (grammar stores `typename` as a single
 * identifier), so arrays must be inferred from array-literal context for now.
 *
 * Pass `aliases` (populated by the type checker from `@type_alias` and
 * `@type_distinct` declarations) to resolve user-defined type names.
 */
export function parseTypeName(name: string, aliases?: Map<string, SiliconType>): SiliconType | undefined {
    switch (name) {
        case 'Int': return TypeInt
        case 'Float': return TypeFloat
        case 'String': return TypeString
        case 'Bool': return TypeBool
        // Low-level escape hatch — WASM types written directly.
        case 'i32': return TypeInt
        case 'f32': return TypeFloat
        default:
            return aliases?.get(name)
    }
}

/**
 * True when `t` is a numeric type (Int or Float). Used by the checker to gate
 * arithmetic operators.
 */
export function isNumeric(t: SiliconType): boolean {
    return t.kind === 'Int' || t.kind === 'Float'
}

/**
 * True when `t` supports ordering operators (`<`, `>`, `<=`, `>=`).
 * String is excluded — pointer ordering is not meaningful.
 */
export function isComparable(t: SiliconType): boolean {
    return t.kind === 'Int' || t.kind === 'Float' || t.kind === 'Bool'
}

/**
 * True when `t` supports equality operators (`==`, `!=`).
 * String is included — compares pointers (reference equality).
 */
export function isEqualityComparable(t: SiliconType): boolean {
    return t.kind === 'Int' || t.kind === 'Float' || t.kind === 'Bool' || t.kind === 'String' || t.kind === 'Sum'
}
