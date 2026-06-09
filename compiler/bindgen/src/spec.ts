// SPDX-License-Identifier: MIT
/**
 * ADR 0017 — FFI binding generator: the hand-authored input spec for the
 * first milestone (Web `Math` + clock, Tier-0).
 *
 * The ADR's spine is "one Binding IR + per-source adapters".  Full WebIDL
 * parsing (`@webref/idl` + `webidl2`) is deferred — those packages are not
 * installed, and the slice is intentionally a known-good, hand-authored table
 * so every downstream stage (IR → tier → typemap → emit-.si → dual-shim →
 * check) is exercised at zero risk.  A real `@webref` adapter later produces
 * this same `BindingSpec[]` shape, so the emitters and golden test don't move.
 *
 * Every entry is Tier-0: every param/result type is in {Int, Int64, Bool,
 * Float, String} (here: Float only), so the bindings are correct-by-construction.
 *
 * `impl` is the per-binding host recipe — the one thing the `.si` signature
 * cannot carry — used by the two JS shim emitters:
 *   - kind:'mathRef'  → Bun aliases the global directly (`math_sin: Math.sin`);
 *                       the browser shim wraps it (`function (x){ return Math.sin(x) }`).
 *   - kind:'call'     → both shims emit a body returning `expr` (clock sources
 *                       have no global to alias).
 */

export type SiType = 'Int' | 'Int64' | 'Bool' | 'Float' | 'String' | 'Void'

export interface Param {
    readonly name: string
    readonly type: SiType
}

export type Impl =
    | { readonly kind: 'mathRef'; readonly method: string }   // Math.<method>
    | { readonly kind: 'call'; readonly expr: string }         // returns <expr>

export interface BindingSpec {
    readonly name: string
    readonly params: readonly Param[]
    readonly result: SiType
    readonly impl: Impl
    /** Source provenance for the lockfile / PR coverage diff. */
    readonly source: string
}

/** Canonical order (random first, then the unary trig/exp group, the binary
 *  ops, the rounding group, abs/min/max, then the two clock sources).  This is
 *  the single source of truth all three emitted artifacts follow — collapsing
 *  the pre-bindgen drift where `js-host.ts` ordered `math_random` last. */
export const WEB_MATH_CLOCK: readonly BindingSpec[] = [
    { name: 'math_random', params: [],                                            result: 'Float', impl: { kind: 'mathRef', method: 'random' }, source: 'webidl:Math.random' },
    { name: 'math_sin',    params: [{ name: 'x', type: 'Float' }],                 result: 'Float', impl: { kind: 'mathRef', method: 'sin' },    source: 'webidl:Math.sin' },
    { name: 'math_cos',    params: [{ name: 'x', type: 'Float' }],                 result: 'Float', impl: { kind: 'mathRef', method: 'cos' },    source: 'webidl:Math.cos' },
    { name: 'math_tan',    params: [{ name: 'x', type: 'Float' }],                 result: 'Float', impl: { kind: 'mathRef', method: 'tan' },    source: 'webidl:Math.tan' },
    { name: 'math_sqrt',   params: [{ name: 'x', type: 'Float' }],                 result: 'Float', impl: { kind: 'mathRef', method: 'sqrt' },   source: 'webidl:Math.sqrt' },
    { name: 'math_log',    params: [{ name: 'x', type: 'Float' }],                 result: 'Float', impl: { kind: 'mathRef', method: 'log' },    source: 'webidl:Math.log' },
    { name: 'math_exp',    params: [{ name: 'x', type: 'Float' }],                 result: 'Float', impl: { kind: 'mathRef', method: 'exp' },    source: 'webidl:Math.exp' },
    { name: 'math_pow',    params: [{ name: 'b', type: 'Float' }, { name: 'e', type: 'Float' }], result: 'Float', impl: { kind: 'mathRef', method: 'pow' },   source: 'webidl:Math.pow' },
    { name: 'math_atan2',  params: [{ name: 'y', type: 'Float' }, { name: 'x', type: 'Float' }], result: 'Float', impl: { kind: 'mathRef', method: 'atan2' }, source: 'webidl:Math.atan2' },
    { name: 'math_floor',  params: [{ name: 'x', type: 'Float' }],                 result: 'Float', impl: { kind: 'mathRef', method: 'floor' },  source: 'webidl:Math.floor' },
    { name: 'math_ceil',   params: [{ name: 'x', type: 'Float' }],                 result: 'Float', impl: { kind: 'mathRef', method: 'ceil' },   source: 'webidl:Math.ceil' },
    { name: 'math_round',  params: [{ name: 'x', type: 'Float' }],                 result: 'Float', impl: { kind: 'mathRef', method: 'round' },  source: 'webidl:Math.round' },
    { name: 'math_abs',    params: [{ name: 'x', type: 'Float' }],                 result: 'Float', impl: { kind: 'mathRef', method: 'abs' },    source: 'webidl:Math.abs' },
    { name: 'math_min',    params: [{ name: 'a', type: 'Float' }, { name: 'b', type: 'Float' }], result: 'Float', impl: { kind: 'mathRef', method: 'min' },   source: 'webidl:Math.min' },
    { name: 'math_max',    params: [{ name: 'a', type: 'Float' }, { name: 'b', type: 'Float' }], result: 'Float', impl: { kind: 'mathRef', method: 'max' },   source: 'webidl:Math.max' },
    { name: 'performance_now', params: [],                                         result: 'Float', impl: { kind: 'call', expr: 'performance.now()' }, source: 'webidl:Performance.now' },
    { name: 'date_now',        params: [],                                         result: 'Float', impl: { kind: 'call', expr: 'Date.now()' },        source: 'webidl:Date.now' },
]

/** The import-module name for these bindings (the WASM `(import "web" …)` namespace). */
export const WEB_MODULE = 'web'
