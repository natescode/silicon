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
}

export interface BindingIR {
    readonly module: string
    readonly decls: readonly BindingDecl[]
}

/** Tier-0 boundary types — every one maps 1:1 to a wasm value type, so a
 *  binding using only these is correct-by-construction (ADR 0017 §tiers). */
const TIER0_TYPES = new Set<SiType>(['Int', 'Int64', 'Bool', 'Float', 'String', 'Void'])

/** Authoritative Silicon-type → wasm value type map (mirrors loader.ts:40). */
export function siToWasm(t: SiType): 'i32' | 'i64' | 'f32' | 'void' {
    switch (t) {
        case 'Float': return 'f32'
        case 'Int64': return 'i64'
        case 'Void':  return 'void'
        default:      return 'i32'   // Int, Bool, String all share i32 at the boundary
    }
}

function classifyTier(spec: BindingSpec): { tier: Tier; reason: string } {
    const types: SiType[] = [...spec.params.map(p => p.type), spec.result]
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
            return { name: s.name, params: s.params, result: s.result, tier, reason, impl: s.impl, source: s.source }
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
        const rhs = d.impl.kind === 'mathRef' ? `Math.${d.impl.method}` : `() => ${d.impl.expr}`
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
        const call = d.impl.kind === 'mathRef' ? `Math.${d.impl.method}(${args})` : d.impl.expr
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
 *  ship under compiler/src/strata/modules/<module>.si and are auto-bundled. */
export function emitModuleSi(ir: BindingIR, provenance: string): string {
    const lines = ir.decls.map(d => {
        const params = d.params.map(p => p.type).join(', ')
        const ret = d.result === 'Void' ? '' : ` -> ${d.result}`
        return `\\\\ @extern ${d.name} (${params})${ret};`
    })
    return [
        '# SPDX-License-Identifier: MIT',
        `# GENERATED by compiler/bindgen from ${provenance} — DO NOT EDIT by hand.`,
        `# Regenerate: \`bun bindgen/cli.ts --write\`.  Call as \`${ir.module}::<fn>\`.`,
        ...lines,
        '',
    ].join('\n')
}

/** Emit a host-shim object body for a generated module: one entry per binding,
 *  marshalling linear-`String` params/results across the boundary via the host
 *  `readLenString` / `allocLenString` helpers (in scope in js-host.ts).  The
 *  accessor + JS method are recovered from each binding's `impl.expr`, so this
 *  works for single-accessor (`Bun`) and multi-accessor (Web interfaces) modules. */
export function emitHostModule(ir: BindingIR, indent = '            '): string {
    return ir.decls.map(d => {
        const expr = d.impl.kind === 'mathRef' ? `Math.${d.impl.method}()` : d.impl.expr
        const head = expr.slice(0, expr.lastIndexOf('('))   // "<accessor>.<method>"
        const dot = head.lastIndexOf('.')
        const accessor = head.slice(0, dot)
        const method = head.slice(dot + 1)
        const args = d.params.map(p => (p.type === 'String' ? `readLenString(${p.name})` : p.name))
        let call = `${accessor}.${method}(${args.join(', ')})`
        if (d.result === 'String') call = `allocLenString(${call})`
        // Every wasm-boundary value is a number (scalars + the i32 String ptr).
        const params = d.params.map(p => `${p.name}: number`).join(', ')
        return `${indent}${d.name}: (${params}) => ${call},`
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
