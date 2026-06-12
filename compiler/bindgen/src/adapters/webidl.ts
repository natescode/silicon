// SPDX-License-Identifier: MIT
/**
 * ADR 0017 — the Web IDL adapter.
 *
 * Parses real upstream Web IDL (via `webidl2`) into the engine-neutral
 * `BindingSpec[]` the emitters consume — the ADR's "one Binding IR + per-source
 * adapters" spine, with Web IDL as the Web source (the only one that preserves
 * integer-vs-float, nullable, and Promise/callback flags; a `.d.ts` collapses
 * every number to `number`).
 *
 * Scope note (honest): `Math.*` and `Date.now()` are **ECMAScript built-ins, not
 * Web IDL** — they have no `@webref/idl` definition — so they come from the
 * hand-authored ECMAScript source, not this adapter.  `Performance.now()` IS Web
 * IDL (`DOMHighResTimeStamp now()` in W3C hr-time), so it is generated here from
 * the genuine spec text.  This is exactly the multi-source design: one IR, an
 * adapter per source.
 */

import * as webidl2 from 'webidl2'
import type { BindingSpec, SiType, Param } from '../spec'

/** Web IDL primitive / typedef'd type → Silicon boundary type.  Mirrors ADR
 *  0017's type-map highlights (`double`/`float` → `Float` (f32, lossy for
 *  `double` — graphics-fine), `unsigned long` → `Int`, `long long` → `Int64`,
 *  `DOMString` → `String`, `undefined` → `Void`). */
export function idlTypeToSi(idlType: string): SiType {
    switch (idlType) {
        case 'double': case 'unrestricted double':
        case 'float':  case 'unrestricted float':           return 'Float'
        case 'long long': case 'unsigned long long':        return 'Int64'
        case 'long': case 'unsigned long':
        case 'short': case 'unsigned short':
        case 'octet': case 'byte':                          return 'Int'
        case 'boolean':                                     return 'Bool'
        case 'DOMString': case 'USVString': case 'ByteString': return 'String'
        case 'undefined': case 'void':                      return 'Void'
        default:
            throw new Error(`webidl adapter: unmapped IDL type '${idlType}' (Tier-1+ — not in the Tier-0 boundary set)`)
    }
}

export interface WebIdlAdapterOptions {
    /** The interface (or namespace) to extract operations from, e.g. 'Performance'. */
    readonly interfaceName: string
    /** Binding-name prefix, e.g. 'performance' → operation 'now' becomes 'performance_now'. */
    readonly prefix: string
    /** The JS global the operations are invoked through, e.g. 'performance'
     *  (→ `performance.now()`).  This is the host-impl recipe Web IDL cannot
     *  carry; supplied per source. */
    readonly accessor: string
}

/** Convert a camelCase / single-word IDL operation name to snake_case. */
function snake(name: string): string {
    return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

/**
 * Parse `idl` (Web IDL source text) and emit a `BindingSpec` per operation of
 * the named interface.  Typedefs are resolved (e.g. `DOMHighResTimeStamp` →
 * `double`).  Only Tier-0-typed operations are emitted; an unmapped type throws
 * (the binding would be Tier-1+ and is out of this slice's scope).
 */
export function webidlToSpecs(idl: string, opts: WebIdlAdapterOptions): BindingSpec[] {
    const tree = webidl2.parse(idl)

    // Resolve typedefs: name → underlying primitive IDL type.
    const typedefs = new Map<string, string>()
    for (const def of tree as any[]) {
        if (def.type === 'typedef' && typeof def.idlType?.idlType === 'string') {
            typedefs.set(def.name, def.idlType.idlType)
        }
    }
    const resolve = (t: string): string => typedefs.get(t) ?? t

    const iface = (tree as any[]).find(d => (d.type === 'interface' || d.type === 'namespace') && d.name === opts.interfaceName)
    if (!iface) throw new Error(`webidl adapter: interface/namespace '${opts.interfaceName}' not found in the IDL`)

    const specs: BindingSpec[] = []
    for (const m of iface.members as any[]) {
        if (m.type !== 'operation' || !m.name) continue
        const params: Param[] = (m.arguments ?? []).map((a: any) => ({
            name: a.name,
            type: idlTypeToSi(resolve(a.idlType?.idlType)),
        }))
        const result = idlTypeToSi(resolve(m.idlType?.idlType))
        const argList = params.map(p => p.name).join(', ')
        specs.push({
            name: `${opts.prefix}_${snake(m.name)}`,
            params,
            result,
            impl: { kind: 'call', expr: `${opts.accessor}.${m.name}(${argList})` },
            source: `webidl:${opts.interfaceName}.${m.name}`,
        })
    }
    return specs
}
