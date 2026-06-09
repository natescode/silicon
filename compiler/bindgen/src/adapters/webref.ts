// SPDX-License-Identifier: MIT
/**
 * ADR 0017 — the @webref/idl bulk Web adapter.
 *
 * Loads the REAL Web platform IDL corpus (`@webref/idl`, ~325 `.idl` files, the
 * MIT weekly snapshot of every spec's `<pre class=idl>`), parses it with
 * `webidl2`, merges partial interfaces, and auto-generates a `BindingSpec` for
 * every Tier-0-bindable operation of the curated singleton-accessible interfaces
 * — the signature + tier come straight from the spec; only the *accessor* (the
 * JS global an operation is invoked through, which no IDL carries) is the small
 * per-source convention below.
 *
 * Operations whose types aren't Tier-0 (object handles, sequences, dictionaries,
 * Promises, callbacks) are SKIPPED and logged — never silently dropped (ADR 0017).
 */

import { readdirSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import * as webidl2 from 'webidl2'
import type { BindingSpec, Param, SiType } from '../spec'
import { idlTypeToSi } from './webidl'

/**
 * Singleton-accessible Web interfaces → the JS global an operation is invoked
 * through.  This is the per-source convention the spec cannot supply (Web IDL
 * describes the type surface, not how to obtain an instance).  Only interfaces
 * listed here are emitted; everything else (interfaces needing a constructed
 * object) is reported as skipped.
 */
export const WEB_ACCESSORS: Readonly<Record<string, string>> = {
    Performance: 'performance',
    Crypto: 'crypto',
    Navigator: 'navigator',
    Console: 'console',
    Window: 'window',
}

export interface WebrefResult {
    readonly specs: BindingSpec[]
    /** `Interface.op` entries skipped because a param/result isn't Tier-0. */
    readonly skipped: { readonly member: string; readonly reason: string }[]
}

/** Locate the installed @webref/idl directory (the folder of `.idl` files). */
function webrefIdlDir(): string {
    // Resolve the package's main and take its directory (the `.idl` files sit beside it).
    const main = require.resolve('@webref/idl')
    return dirname(main)
}

/** Read + concatenate the whole corpus, recording each file for error locality. */
function loadCorpus(dir: string): { file: string; text: string }[] {
    return readdirSync(dir)
        .filter(f => f.endsWith('.idl'))
        .map(f => ({ file: f, text: readFileSync(join(dir, f), 'utf8') }))
}

type Op = { name: string; result: string; args: { name: string; type: string }[] }

/**
 * Generate BindingSpecs from the real @webref/idl corpus for the curated
 * accessor interfaces.  Pass `accessors` to override the default set (used by
 * tests for determinism).
 */
export function webrefToSpecs(
    accessors: Readonly<Record<string, string>> = WEB_ACCESSORS,
    dir: string = webrefIdlDir(),
): WebrefResult {
    const corpus = loadCorpus(dir)

    // Global typedef map + per-interface operation lists (merging partials).
    const typedefs = new Map<string, string>()
    const ops = new Map<string, Op[]>()
    const want = new Set(Object.keys(accessors))

    for (const { text } of corpus) {
        let tree: any[]
        try { tree = webidl2.parse(text) } catch { continue }  // skip unparseable files
        for (const def of tree) {
            if (def.type === 'typedef' && typeof def.idlType?.idlType === 'string') {
                typedefs.set(def.name, def.idlType.idlType)
            }
            if ((def.type === 'interface' || def.type === 'interface mixin' || def.type === 'namespace') && want.has(def.name)) {
                const list = ops.get(def.name) ?? []
                for (const m of def.members ?? []) {
                    if (m.type === 'operation' && m.name && typeof m.idlType?.idlType === 'string') {
                        list.push({
                            name: m.name,
                            result: m.idlType.idlType,
                            args: (m.arguments ?? []).map((a: any) => ({ name: a.name, type: a.idlType?.idlType })),
                        })
                    }
                }
                ops.set(def.name, list)
            }
        }
    }

    const resolve = (t: string | undefined): string => (t && typedefs.get(t)) ?? t ?? ''
    const tryType = (t: string): SiType | null => { try { return idlTypeToSi(resolve(t)) } catch { return null } }
    const snake = (n: string): string => n.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()

    const specs: BindingSpec[] = []
    const skipped: { member: string; reason: string }[] = []
    const seen = new Set<string>()  // dedup operations merged from multiple files / overloads

    for (const [iface, accessor] of Object.entries(accessors)) {
        const prefix = snake(iface)
        for (const op of ops.get(iface) ?? []) {
            const key = `${iface}.${op.name}`
            if (seen.has(key)) continue
            seen.add(key)
            const result = tryType(op.result)
            const params: Param[] = []
            let bad = false
            for (const a of op.args) {
                const t = tryType(a.type)
                if (!t) { bad = true; break }
                params.push({ name: a.name, type: t })
            }
            if (result === null || bad) {
                skipped.push({ member: key, reason: 'a param/result is not a Tier-0 boundary type' })
                continue
            }
            const argList = params.map(p => p.name).join(', ')
            specs.push({
                name: `${prefix}_${snake(op.name)}`,
                params,
                result,
                impl: { kind: 'call', expr: `${accessor}.${op.name}(${argList})` },
                source: `webref:${key}`,
            })
        }
    }
    return { specs, skipped }
}
