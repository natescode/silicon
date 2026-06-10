// SPDX-License-Identifier: MIT
/**
 * ADR 0017 — the binding generator: BindingSpec[] → Binding IR → the three
 * emitted artifacts that must agree (the `.si` `@extern` block + both JS host
 * shims).  One IR, three emitters — the ADR's lockstep spine.
 */

import type { BindingSpec, SiType, Impl } from './spec'

// ── Binding IR ──────────────────────────────────────────────────────────────

export type Tier = 0 | 1 | 2

export interface BindingDecl {
    readonly name: string
    readonly params: readonly { name: string; type: SiType }[]
    readonly result: SiType
    readonly tier: Tier
    readonly reason: string
    readonly impl: Impl
    readonly source: string
    /** ADR 0018 — Promise-returning: emit `@suspending @extern`; `result` is the
     *  awaited type (the F1b reactor drives the suspension). */
    readonly suspending?: boolean
}

export interface BindingIR {
    readonly module: string
    readonly decls: readonly BindingDecl[]
}

/** Tier-0 boundary types — every one maps 1:1 to a wasm value type, so a
 *  binding using only these is correct-by-construction (ADR 0017 §tiers). */
const TIER0_TYPES = new Set<SiType>(['Int', 'Int64', 'Bool', 'Float', 'String', 'Void'])

/** Authoritative Silicon-type → wasm value type map (mirrors loader.ts:40). */
export function siToWasm(t: SiType): 'i32' | 'i64' | 'f32' | 'void' | 'externref' {
    switch (t) {
        case 'Float': return 'f32'
        case 'Int64': return 'i64'
        case 'Void':  return 'void'
        case 'JSString':
        case 'JSValue': return 'externref'   // engine-native object handles (web/bun)
        case 'Callback': return 'i32'        // closure handle (Vec[Int]; a ref under wasm-gc)
        default:      return 'i32'   // Int, Bool, String all share i32 at the boundary
    }
}

function classifyTier(spec: BindingSpec): { tier: Tier; reason: string } {
    const types: SiType[] = [...spec.params.map(p => p.type), spec.result]
    // Tier-2: a closure-handle callback param (ADR 0019 C2).
    if (types.includes('Callback')) return { tier: 2, reason: `closure callback 'Callback'` }
    // Tier-2: an opaque host-object handle (JSValue externref).
    if (types.includes('JSValue')) return { tier: 2, reason: `object handle 'JSValue' (externref)` }
    // Tier-1: an engine-native string handle (JSString externref).
    if (types.includes('JSString')) return { tier: 1, reason: `string handle 'JSString' (externref)` }
    const offending = types.find(t => !TIER0_TYPES.has(t))
    if (offending) return { tier: 1, reason: `non-Tier-0 type '${offending}'` }
    return { tier: 0, reason: 'all params/result are Tier-0 boundary types' }
}

/** Adapt a hand-authored (or, later, WebIDL-derived) spec list into the IR. */
export function buildIR(module: string, specs: readonly BindingSpec[]): BindingIR {
    return {
        module,
        decls: specs.map(s => {
            const { tier, reason } = classifyTier(s)
            return { name: s.name, params: s.params, result: s.result, tier, reason, impl: s.impl, source: s.source, suspending: s.suspending }
        }),
    }
}

// ── Emitters ──────────────────────────────────────────────────────────────────
// Each reproduces the exact byte layout of its target's marked region so that
// `bindgen --check` is a no-op diff against the committed source.

const SI_INDENT = ''
const JS_INDENT = '            ' // 12 spaces — inside the `web:` / `var web = {` object

/** Split decls into the `math_*` group and the clock group, render each with
 *  `line`, and join the two groups with a single blank line — the canonical
 *  layout shared by all three artifacts. */
function grouped(ir: BindingIR, line: (d: BindingDecl) => string): string {
    const math = ir.decls.filter(d => d.name.startsWith('math_')).map(line)
    const clock = ir.decls.filter(d => !d.name.startsWith('math_')).map(line)
    return [...math, '', ...clock].join('\n')
}

/** `.si` `@extern` block (target: compiler/src/strata/modules/web.si). */
export function emitSi(ir: BindingIR): string {
    return grouped(ir, d => {
        const params = d.params.map(p => p.type).join(', ')
        const ret = d.result === 'Void' ? '' : ` -> ${d.result}`
        return `${SI_INDENT}\\\\ @extern ${d.name} (${params})${ret};`
    })
}

/** Bun host shim fragment (target: cli/src/host/js-host.ts `web:` object).
 *  Terse, one binding per line: `math_sin: Math.sin,` for Math aliases,
 *  `performance_now: () => performance.now(),` for clock sources. */
export function emitBunShim(ir: BindingIR): string {
    return grouped(ir, d => {
        // The web Math/clock surface only ever uses mathRef/call impls.
        const rhs = d.impl.kind === 'mathRef' ? `Math.${d.impl.method}` : `() => ${(d.impl as { expr: string }).expr}`
        return `${JS_INDENT}${d.name}: ${rhs},`
    })
}

/** Browser host shim fragment (target: playground/playground/web-env.js
 *  `var web = {…}`).  Column-aligned wrapper functions:
 *    `math_sin:        function (x)       { return Math.sin(x) },`
 *  Name+colon padded to 16, then the `function (args)` field padded to 18. */
export function emitWebShim(ir: BindingIR): string {
    return grouped(ir, d => {
        const args = d.params.map(p => p.name).join(', ')
        const call = d.impl.kind === 'mathRef' ? `Math.${d.impl.method}(${args})` : (d.impl as { expr: string }).expr
        const name = `${d.name}:`.padEnd(16)
        const fn = `function (${args})`.padEnd(18)
        return `${JS_INDENT}${name} ${fn} { return ${call} },`
    })
}

// ── Whole-module emitters (Node / Bun — a generated .si module + host shim) ──
// Unlike the Web Math/clock surface (which splices fragments into existing files),
// a Node/Bun namespace becomes its OWN built-in module file + a marshalling host
// shim, callable as `<module>::<fn>`.

/** Emit a complete generated `.si` module file (header + @extern block).  These
 *  ship under compiler/src/strata/modules/<module>.si and are auto-bundled.
 *
 *  `strings` selects the string boundary representation (ADR 0017 tiers):
 *    'linear'   (Tier-0) — `String` crosses as a linear-memory pointer, host-
 *                          marshalled; works on every target.
 *    'jsstring' (Tier-1) — `String` is emitted as `JSString`, an engine-native
 *                          externref handle (the F1a machinery); the host passes
 *                          JS strings DIRECTLY (zero linear-memory marshalling).
 *                          externref needs a JS host, so it is web/bun-only. */
export type StringTier = 'linear' | 'jsstring'

export function emitModuleSi(ir: BindingIR, provenance: string, strings: StringTier = 'linear'): string {
    const ty = (t: string): string =>
        t === 'Callback' ? 'Vec[Int]'                                  // closure handle (ADR 0019 C2)
        : (strings === 'jsstring' && t === 'String') ? 'JSString'
        : t
    const lines = ir.decls.map(d => {
        const params = d.params.map(p => ty(p.type)).join(', ')
        const ret = d.result === 'Void' ? '' : ` -> ${ty(d.result)}`
        // A Promise-returning API emits `@suspending @extern` (ADR 0018) so the
        // host reactor drives the unwind/await/rewind (or JSPI suspend).
        const mod = d.suspending ? '@suspending @extern' : '@extern'
        return `\\\\ ${mod} ${d.name} (${params})${ret};`
    })
    const hasJsValue = ir.decls.some(d => d.result === 'JSValue' || d.params.some(p => p.type === 'JSValue'))
    const tierNote = hasJsValue
        ? '  (Tier-2: JSValue = object handle, externref, web/bun only)'
        : strings === 'jsstring' ? '  (Tier-1: JSString = externref, web/bun only)' : ''
    return [
        '# SPDX-License-Identifier: MIT',
        `# GENERATED by compiler/bindgen from ${provenance} — DO NOT EDIT by hand.`,
        `# Regenerate: \`bun bindgen/cli.ts --write\`.  Call as \`${ir.module}::<fn>\`.${tierNote}`,
        ...lines,
        '',
    ].join('\n')
}

/** Emit a host-shim object body for a generated module: one entry per binding.
 *  In 'linear' mode (Tier-0) `String` params/results are marshalled via the host
 *  `readLenString`/`allocLenString` helpers (in scope in js-host.ts).  In
 *  'jsstring' mode (Tier-1) NO marshalling is emitted — a `JSString` crosses as
 *  the JS string itself (externref), so the host call is direct.  The accessor +
 *  JS method are recovered from each binding's `impl.expr`. */
export function emitHostModule(ir: BindingIR, indent = '            ', strings: StringTier = 'linear'): string {
    const js = strings === 'jsstring'
    // Marshal one param at the host boundary: a linear String is an i32 ptr →
    // `readLenString`; a jsstring String / JSString / JSValue is the JS value
    // itself (pass-through); scalars pass through.
    const inArg = (p: { name: string; type: SiType }): string =>
        p.type === 'Callback' ? `closureToFn(${p.name})`              // closure handle → JS fn (ADR 0019 C2)
        : (!js && p.type === 'String') ? `readLenString(${p.name})`
        : p.name
    // Wrap a String result back into linear memory (jsstring/JSValue/scalar pass through).
    const outWrap = (call: string, result: SiType): string =>
        (!js && result === 'String') ? `allocLenString(${call})` : call
    // Param TS type at the boundary: externref handles + jsstring Strings are
    // `any`; linear String ptrs and all scalars are `number`.
    const ptype = (t: SiType): string =>
        (t === 'JSValue' || t === 'JSString' || t === 'Callback' || (js && t === 'String')) ? 'any' : 'number'

    return ir.decls.map(d => {
        const sig = d.params.map(p => `${p.name}: ${ptype(p.type)}`).join(', ')
        let call: string
        switch (d.impl.kind) {
            case 'mathRef': {
                call = outWrap(`Math.${d.impl.method}(${d.params.map(inArg).join(', ')})`, d.result)
                break
            }
            case 'call': {
                // accessor.method recovered from impl.expr; params re-marshalled in
                // declaration order (so the jsstring/linear rule is reapplied).
                const head = d.impl.expr.slice(0, d.impl.expr.lastIndexOf('('))
                const dot = head.lastIndexOf('.')
                call = outWrap(`${head.slice(0, dot)}.${head.slice(dot + 1)}(${d.params.map(inArg).join(', ')})`, d.result)
                break
            }
            case 'spread': {
                // The TRAILING JSValue param is an array handle the host spreads;
                // any preceding fixed params are passed normally first
                // (`accessor.method(fixed…, ...args)` — e.g. `Bun.$(strings, ...args)`).
                const fixed = d.params.slice(0, -1).map(inArg)
                const rest = `...${d.params[d.params.length - 1].name}`
                call = outWrap(`${d.impl.accessor}.${d.impl.method}(${[...fixed, rest].join(', ')})`, d.result)
                break
            }
            case 'construct':
                // new Iface(args…) → a fresh JSValue handle (result is JSValue, never wrapped).
                call = `new ${d.impl.iface}(${d.params.map(inArg).join(', ')})`
                break
            case 'static':
                call = outWrap(`${d.impl.iface}.${d.impl.method}(${d.params.map(inArg).join(', ')})`, d.result)
                break
            case 'method': {
                // params[0] is the receiver handle — NOT marshalled (it's a JSValue).
                const [recv, ...rest] = d.params
                call = outWrap(`${recv.name}.${d.impl.method}(${rest.map(inArg).join(', ')})`, d.result)
                break
            }
            case 'getter':
                call = outWrap(`${d.params[0].name}.${d.impl.attr}`, d.result)
                break
            case 'setter': {
                // (receiver: JSValue, value: T) -> Void.  value is params[1].
                const [recv, value] = d.params
                call = `${recv.name}.${d.impl.attr} = ${inArg(value)}`
                break
            }
        }
        return `${indent}${d.name}: (${sig}) => ${call},`
    }).join('\n')
}

/** Everything an emitter/check needs from one generation pass. */
export interface Generated {
    readonly ir: BindingIR
    readonly si: string
    readonly bunShim: string
    readonly webShim: string
    /** The (module, field, arity) key set — the ADR lockstep invariant: it must
     *  be identical across the `.si` decls and both shims. */
    readonly keys: readonly string[]
}

export function generate(module: string, specs: readonly BindingSpec[]): Generated {
    const ir = buildIR(module, specs)
    return {
        ir,
        si: emitSi(ir),
        bunShim: emitBunShim(ir),
        webShim: emitWebShim(ir),
        keys: ir.decls.map(d => `${module}::${d.name}/${d.params.length}`),
    }
}
