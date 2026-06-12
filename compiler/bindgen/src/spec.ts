// SPDX-License-Identifier: MIT
/**
 * ADR 0017 — FFI binding generator: the Web `Math` + clock binding surface
 * (Tier-0), composed from per-source adapters per the ADR's "one Binding IR +
 * per-source adapters" spine:
 *   - `Math.*` and `Date.now()` are ECMAScript built-ins (NOT Web IDL — they
 *     have no `@webref/idl` definition), so they come from the hand-authored
 *     ECMAScript tables `MATH`/`DATE` below.
 *   - `Performance.now()` IS Web IDL (W3C High Resolution Time), so it is
 *     GENERATED from the genuine spec text by the `webidl2` adapter
 *     (`adapters/webidl.ts`) — the generator is Web-IDL-driven for that binding.
 *
 * Every entry is Tier-0: every param/result type is in {Int, Int64, Bool,
 * Float, String} (here: Float only), so the bindings are correct-by-construction.
 *
 * `impl` is the per-binding host recipe — the one thing a `.si` signature (or
 * Web IDL) cannot carry — used by the two JS shim emitters:
 *   - kind:'mathRef'  → Bun aliases the global directly (`math_sin: Math.sin`);
 *                       the browser shim wraps it (`function (x){ return Math.sin(x) }`).
 *   - kind:'call'     → both shims emit a body returning `expr` (clock sources
 *                       have no global to alias).
 */

import { webidlToSpecs } from './adapters/webidl'

export type SiType = 'Int' | 'Int64' | 'Bool' | 'Float' | 'String' | 'Void'
    // Tier-1/Tier-2 externref object handles (ADR 0018, web/bun only):
    //   JSString — an engine-native string handle (the `wasm:js-string` builtins).
    //   JSValue  — an opaque host-object handle (any JS object/array crosses as
    //              an externref; engine-GC'd, no manual release).
    | 'JSString' | 'JSValue'
    // ADR 0019 C2 — a CALLBACK param: a closure crossing `@extern`.  Emitted as the
    // closure handle `Vec[Int]` (a `(ref $Vec_i32)` under wasm-gc — engine-GC'd);
    // the guest passes `@export_callback(@closure(…))` and the host calls it back
    // through the synthesized `__closure_invoke_<k>` trampoline.
    | 'Callback'

export interface Param {
    readonly name: string
    readonly type: SiType
}

export type Impl =
    | { readonly kind: 'mathRef'; readonly method: string }   // Math.<method>
    | { readonly kind: 'call'; readonly expr: string }         // returns <expr>
    // A VARIADIC host fn (`path.join(...paths)`, `Bun.$`): the single trailing
    // JSValue param is an array handle the host SPREADS — `accessor.method(...args)`.
    // accessor/method are structural so the emitter never re-parses an expr.
    | { readonly kind: 'spread'; readonly accessor: string; readonly method: string } // accessor.method(...args)
    // ADR 0018 — constructed Web interface shapes (Tier-2).  The host
    // accessor/receiver is STRUCTURAL (not embedded in a string), so the emitter
    // never re-parses an expr.  `iface` is the JS global the ctor/static is
    // reached through (e.g. `URL`); a method/getter/setter takes its receiver as
    // params[0] (a JSValue handle, never marshalled).
    | { readonly kind: 'construct'; readonly iface: string }                        // new Iface(args…)
    | { readonly kind: 'method'; readonly method: string }                          // params[0].method(rest…)
    | { readonly kind: 'getter'; readonly attr: string }                            // params[0].attr
    | { readonly kind: 'setter'; readonly attr: string }                            // params[0].attr = value
    | { readonly kind: 'static'; readonly iface: string; readonly method: string }  // Iface.method(args…)

export interface BindingSpec {
    readonly name: string
    readonly params: readonly Param[]
    readonly result: SiType
    readonly impl: Impl
    /** Source provenance for the lockfile / PR coverage diff. */
    readonly source: string
    /** ADR 0018 — a Promise-returning host API: emits `@suspending @extern` and
     *  `result` is the AWAITED type.  The host shim returns the Promise (the F1b
     *  reactor drives the suspension); the awaited value crosses as an externref
     *  (JSString/JSValue) or scalar — never linear String (the reactor returns the
     *  raw resolved value, so there is no host-side marshalling hook). */
    readonly suspending?: boolean
}

// ── ECMAScript source: Math (the `mathRef` helper) ──────────────────────────
// `Math.*` is an ECMAScript built-in, NOT Web IDL — there is no `@webref/idl`
// definition for it — so it comes from this hand-authored ECMAScript table, not
// the Web IDL adapter (ADR 0017's "one IR, an adapter per source").
const m = (name: string, args: string[]): BindingSpec => ({
    name: `math_${name}`,
    params: args.map(a => ({ name: a, type: 'Float' as const })),
    result: 'Float',
    impl: { kind: 'mathRef', method: name === 'random' ? 'random' : name },
    source: `ecmascript:Math.${name}`,
})
const MATH: readonly BindingSpec[] = [
    m('random', []), m('sin', ['x']), m('cos', ['x']), m('tan', ['x']),
    m('sqrt', ['x']), m('log', ['x']), m('exp', ['x']),
    m('pow', ['b', 'e']), m('atan2', ['y', 'x']),
    m('floor', ['x']), m('ceil', ['x']), m('round', ['x']), m('abs', ['x']),
    m('min', ['a', 'b']), m('max', ['a', 'b']),
]

// ── ECMAScript source: Date ─────────────────────────────────────────────────
// `Date.now()` is also an ECMAScript built-in, not Web IDL.
const DATE: readonly BindingSpec[] = [
    { name: 'date_now', params: [], result: 'Float', impl: { kind: 'call', expr: 'Date.now()' }, source: 'ecmascript:Date.now' },
]

/** Count of hand-authored ECMAScript bindings (no machine-readable spec). */
export const MATH_DATE_COUNT = MATH.length + DATE.length

// ── Web IDL source: Performance (genuinely generated) ────────────────────────
// `Performance.now()` IS Web IDL (W3C High Resolution Time).  This is the real
// upstream spec text, parsed by the webidl2 adapter into a BindingSpec — the
// generator is Web-IDL-driven for this binding (see PERFORMANCE_NOW below).
export const PERFORMANCE_IDL = `typedef double DOMHighResTimeStamp;
[Exposed=(Window,Worker)]
interface Performance : EventTarget {
  DOMHighResTimeStamp now();
};`

// The composed surface preserves the canonical order (Math, then Performance,
// then Date) so the emitted artifacts are stable.
export function buildWebMathClock(performance: readonly BindingSpec[]): readonly BindingSpec[] {
    return [...MATH, ...performance, ...DATE]
}

// `Performance.now()` generated from the real Web IDL above via the webidl2
// adapter (the import is type-erased in webidl.ts, so there is no runtime cycle).
const PERFORMANCE: readonly BindingSpec[] = webidlToSpecs(PERFORMANCE_IDL, {
    interfaceName: 'Performance', prefix: 'performance', accessor: 'performance',
})

/** The Web Math/clock binding surface — Math/Date from the ECMAScript table,
 *  Performance generated from real Web IDL.  Single source of truth for the
 *  `.si` externs + both host shims. */
export const WEB_MATH_CLOCK: readonly BindingSpec[] = buildWebMathClock(PERFORMANCE)

/** The import-module name for these bindings (the WASM `(import "web" …)` namespace). */
export const WEB_MODULE = 'web'
