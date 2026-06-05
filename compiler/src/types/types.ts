// SPDX-License-Identifier: MIT
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
    | { kind: 'Int64' }
    | { kind: 'Float' }
    | { kind: 'String' }
    | { kind: 'Bool' }
    // Phase 5b — unsigned integer types.  At the WASM level u8/u16/u32 map
    // to i32 and u64 maps to i64; the distinction is enforced by the type
    // checker and routes through the *_u WASM instruction variants for
    // div, rem, shr, and the four unsigned comparisons.  u8 and u16 share
    // the i32 representation with u32 for 1.0 — explicit narrowing /
    // masking on store is a 1.x improvement; users that need exact
    // wrap-around semantics should cast through u32 and mask explicitly.
    | { kind: 'UInt8'  }
    | { kind: 'UInt16' }
    | { kind: 'UInt32' }
    | { kind: 'UInt64' }
    // JS String Builtins (web/bun platform).  An opt-in handle to a *JavaScript*
    // string, represented as `externref` at the WASM level (NOT the linear-memory
    // UTF-8 `String`).  Operations route through the host's `wasm:js-string`
    // builtins.  Only available under `--platform=web|bun`; on the operand stack
    // / in locals it is i32-shaped (the binary emitter encodes the externref
    // valtype via a ref slot — see IRRefSlot.extern).
    | { kind: 'JSString' }
    // A WASM-GC `(array (mut i16))` of UTF-16 code units, used to feed / receive
    // the `wasm:js-string` `fromCharCodeArray` / `intoCharCodeArray` builtins.
    // Opaque GC reference (i32-shaped on the stack; the ref-ness rides on a
    // concrete ref slot — see IRRefSlot).  Web/bun platform only.
    | { kind: 'CharCodeArray' }
    | { kind: 'Array'; element: SiliconType }
    // Phase 9d-8 — growable container (`Vec[Int]`, `Vec[Float]`, …).
    // Nominally distinct from `Array[T]` (which is fixed-length); maps
    // to the stdlib `vec_*` API at the runtime level.  Under wasm-mvp
    // a `Vec[T]` is an i32 (heap pointer to the linear-memory header);
    // under wasm-gc it lowers to `(ref $Vec_T)` — see
    // `src/codegen/gc-vec.ts`.
    | { kind: 'Vec'; element: SiliconType }
    | { kind: 'Function'; params: SiliconType[]; result: SiliconType }
    // A user-defined distinct type. Structurally identical to `underlying` in
    // WASM, but incompatible with it (and with other Distinct types) at the
    // Silicon level. Use `wasmTypeOf` to get the concrete WASM encoding.
    | { kind: 'Distinct'; name: string; underlying: SiliconType }
    // A user-defined sum type. Variants are stored as i32 constants (0, 1, …)
    // and are accessed as `Name::Variant` namespace references.  `typeArgs`,
    // when present, makes `Option[Int]` and `Option[Float]` distinct nominal
    // types: same `name` and `variants`, different `typeArgs`.  Absent for
    // non-parametric sums (e.g. plain `@type Color := $Red | $Green;`).
    | { kind: 'Sum'; name: string; variants: string[]; typeArgs?: SiliconType[] }
    // `Unknown` is the top type used when the checker cannot determine a type
    // (e.g. references to unbound identifiers). It never appears in a
    // well-typed program. Downstream code should treat `Unknown` as "do not
    // propagate further errors from this node".
    | { kind: 'Unknown' }
    // `Void` is the unit type for functions that return nothing.
    | { kind: 'Void' }
    // `Variable` is a compile-time type placeholder for generic type parameters.
    | { kind: 'Variable'; name: string }

/**
 * A *Type scheme* — a polymorphic type bound over a list of type variables.
 *
 *   schemeOf(['T'], FunctionOf([Variable('T')], Variable('T'))) =
 *       ∀T. T → T              ── the type of `@fn id[T] x:T := x`
 *
 * Schemes only appear in symbol-table / function-signature positions: they
 * represent declared polymorphism on @fn[T] / @type[T].  At a call site, a
 * scheme is *instantiated* by replacing its bound vars with fresh `Variable`s,
 * and then unified against arg types.
 *
 * Roc-style restriction: schemes are introduced ONLY by syntactic [T]
 * declarations, never auto-generalised from inferred locals.  This keeps the
 * inference algorithm small and predictable.
 */
export interface Scheme {
    tvars: string[]
    type:  SiliconType
}

export function schemeOf(tvars: string[], type: SiliconType): Scheme {
    return { tvars, type }
}

/** Convenience: a monomorphic Scheme (no type vars) — wraps a plain type. */
export function monoScheme(type: SiliconType): Scheme {
    return { tvars: [], type }
}

/**
 * The set of WebAssembly value types Silicon currently targets. `void` is used
 * for expressions that produce no stack value (e.g. prints, stores).
 */
export type WasmType = 'i32' | 'i64' | 'f32' | 'void'

/**
 * Pre-constructed singletons for the common primitive types. Using these
 * avoids allocating a fresh object every time the checker names a type.
 */
export const TypeInt: SiliconType = { kind: 'Int' }
export const TypeInt64: SiliconType = { kind: 'Int64' }
export const TypeFloat: SiliconType = { kind: 'Float' }
export const TypeString: SiliconType = { kind: 'String' }
export const TypeJSString: SiliconType = { kind: 'JSString' }
export const TypeCharCodeArray: SiliconType = { kind: 'CharCodeArray' }
export const TypeBool: SiliconType = { kind: 'Bool' }
export const TypeUInt8:  SiliconType = { kind: 'UInt8'  }
export const TypeUInt16: SiliconType = { kind: 'UInt16' }
export const TypeUInt32: SiliconType = { kind: 'UInt32' }
export const TypeUInt64: SiliconType = { kind: 'UInt64' }
export const TypeUnknown: SiliconType = { kind: 'Unknown' }

/**
 * Construct an Array[T] type.
 */
export function ArrayOf(element: SiliconType): SiliconType {
    return { kind: 'Array', element }
}

/** Phase 9d-8 — construct a `Vec[T]` growable container type. */
export function VecOf(element: SiliconType): SiliconType {
    return { kind: 'Vec', element }
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
export function SumOf(name: string, variants: string[], typeArgs?: SiliconType[]): SiliconType {
    return typeArgs && typeArgs.length > 0
        ? { kind: 'Sum', name, variants, typeArgs }
        : { kind: 'Sum', name, variants }
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
        case 'JSString': // externref — i32-shaped on the stack; the ref-ness is
                         // encoded by the caller via IRRefSlot.extern (like Vec under wasm-gc)
        case 'CharCodeArray': // (ref $Array_i16) — i32-shaped; ref via concrete IRRefSlot
        case 'Array':    // pointer
        case 'Vec':      // Phase 9d-8: pointer (mvp) or ref (wasm-gc — ref-ness encoded by caller)
        case 'Function': // function table index
        case 'UInt8':    // sub-i32 widths share the i32 representation
        case 'UInt16':
        case 'UInt32':
            return 'i32'
        case 'Int64':
        case 'UInt64':
            return 'i64'
        case 'Float':
            return 'f32'
        case 'Distinct':
            return wasmTypeOf(t.underlying)
        case 'Sum':
            return 'i32'
        case 'Unknown':
        case 'Variable':
        case 'Void':
            // Conservative: assume i32 so codegen still emits something plausible
            // when a type error has been reported upstream (Variable should be
            // substituted before codegen; Void is unit and never carries a value).
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
    if (a.kind === 'Vec' && b.kind === 'Vec') {
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
    // Sum types are equal when name AND typeArgs match.  `Option[Int]` and
    // `Option[Float]` share a name but differ structurally.
    if (a.kind === 'Sum' && b.kind === 'Sum') {
        if (a.name !== b.name) return false
        const aArgs = a.typeArgs ?? []
        const bArgs = b.typeArgs ?? []
        if (aArgs.length !== bArgs.length) return false
        for (let i = 0; i < aArgs.length; i++) {
            if (!typeEquals(aArgs[i], bArgs[i])) return false
        }
        return true
    }
    // Type variables are equal when they share a name.  Two different
    // variables (?T1 vs ?T2) are NOT equal — unification handles that.
    if (a.kind === 'Variable' && b.kind === 'Variable') {
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
        case 'Int64': return 'Int64'
        case 'Float': return 'Float'
        case 'String': return 'String'
        case 'JSString': return 'JSString'
        case 'CharCodeArray': return 'CharCodeArray'
        case 'Bool': return 'Bool'
        case 'UInt8':  return 'u8'
        case 'UInt16': return 'u16'
        case 'UInt32': return 'u32'
        case 'UInt64': return 'u64'
        case 'Array': return `Array[${formatType(t.element)}]`
        case 'Vec':   return `Vec[${formatType(t.element)}]`
        case 'Function': return `Function(${t.params.map(formatType).join(', ')}) -> ${formatType(t.result)}`
        case 'Distinct': return t.name
        case 'Sum': {
            if (t.typeArgs && t.typeArgs.length > 0) {
                return `${t.name}[${t.typeArgs.map(formatType).join(', ')}]`
            }
            return `${t.name}(${t.variants.join(' | ')})`
        }
        case 'Variable': return t.name
        case 'Void': return 'Void'
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
        // Int32 is a fixed-width alias for the target-sized Int. On wasm32
        // these are identical; on a future wasm64 target, Int would map to
        // Int64 while Int32 stayed at i32.
        case 'Int32': return TypeInt
        case 'Int64': return TypeInt64
        case 'Float': return TypeFloat
        case 'String': return TypeString
        case 'JSString': return TypeJSString
        case 'CharCodeArray': return TypeCharCodeArray
        case 'Bool': return TypeBool
        // Phase 5b — unsigned integer types.
        case 'u8':  case 'UInt8':  return TypeUInt8
        case 'u16': case 'UInt16': return TypeUInt16
        case 'u32': case 'UInt32': return TypeUInt32
        case 'u64': case 'UInt64': return TypeUInt64
        // Functions declared `:Void` have no return type; we model that as
        // TypeUnknown so callers don't try to read a value off the call.
        case 'Void': return TypeUnknown
        // Low-level escape hatch — WASM types written directly.
        case 'i32': return TypeInt
        case 'i64': return TypeInt64
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
    return t.kind === 'Int' || t.kind === 'Int64' || t.kind === 'Float'
        || t.kind === 'UInt8' || t.kind === 'UInt16'
        || t.kind === 'UInt32' || t.kind === 'UInt64'
}

/** Phase 5b — true when `t` is an unsigned integer type. */
export function isUnsigned(t: SiliconType): boolean {
    return t.kind === 'UInt8' || t.kind === 'UInt16'
        || t.kind === 'UInt32' || t.kind === 'UInt64'
}

/**
 * True when `t` supports ordering operators (`<`, `>`, `<=`, `>=`).
 * String is excluded — pointer ordering is not meaningful.
 */
export function isComparable(t: SiliconType): boolean {
    return t.kind === 'Int' || t.kind === 'Int64' || t.kind === 'Float' || t.kind === 'Bool'
        || t.kind === 'UInt8' || t.kind === 'UInt16'
        || t.kind === 'UInt32' || t.kind === 'UInt64'
}

/**
 * True when `t` supports equality operators (`==`, `!=`).
 * String is included — compares pointers (reference equality).
 */
export function isEqualityComparable(t: SiliconType): boolean {
    return t.kind === 'Int' || t.kind === 'Int64' || t.kind === 'Float' || t.kind === 'Bool' || t.kind === 'String' || t.kind === 'Sum'
        || t.kind === 'UInt8' || t.kind === 'UInt16'
        || t.kind === 'UInt32' || t.kind === 'UInt64'
}
