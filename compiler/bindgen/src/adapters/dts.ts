// SPDX-License-Identifier: MIT
/**
 * ADR 0017 — the TypeScript `.d.ts` adapter (Node + Bun sources).
 *
 * Node and Bun have no Web IDL, so their API surface is read from their REAL
 * `.d.ts` type definitions (`@types/node`, `bun-types`) through the TypeScript
 * compiler API — the same parser/checker a TS IDE uses, resolving aliases and
 * string-literal unions (e.g. `NodeJS.Platform`) to concrete types.  A
 * `BindingSpec` is emitted per callable export whose resolved signature is
 * Tier-0; everything else (objects, sequences, Promises, callbacks) is skipped
 * and logged.
 *
 * The one heuristic (ADR 0017): TS `number` is opaque — it could be an integer
 * or a float — so `numberType` selects the mapping (default `Float`, the safe
 * f32 boundary; flip to `Int` per-namespace where the API is integer-valued).
 * Web IDL does NOT need this (it distinguishes `unsigned long` from `double`).
 */

import ts from 'typescript'
import type { BindingSpec, Param, SiType } from '../spec'

export interface DtsSource {
    /** A module specifier to import (`import * as M from '<module>'`), e.g. 'node:path'. */
    readonly module?: string
    /** OR a global namespace identifier already in scope via the types, e.g. 'Bun'. */
    readonly global?: string
    /** Ambient type packages to load (tsconfig `types`), e.g. ['node'] or ['bun-types']. */
    readonly types: string[]
    /** The JS expression that reaches the namespace at the host, e.g.
     *  "require('node:path')" or "Bun" — the impl recipe no `.d.ts` carries. */
    readonly accessor: string
    /** Binding-name prefix, e.g. 'path' → `path_basename`. */
    readonly prefix: string
    /** How to map TS `number` (the int-vs-float heuristic). Default 'Float'. */
    readonly numberType?: SiType
}

export interface DtsResult {
    readonly specs: BindingSpec[]
    readonly skipped: { readonly member: string; readonly reason: string }[]
}

/** Resolve a TS type to a Tier-0 Silicon type, or null if it isn't Tier-0. */
function tsTypeToSi(t: ts.Type, numberType: SiType): SiType | null {
    const f = t.flags
    if (f & ts.TypeFlags.StringLike)  return 'String'
    if (f & ts.TypeFlags.NumberLike)  return numberType
    if (f & ts.TypeFlags.BooleanLike) return 'Bool'
    if (f & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) return 'Void'
    if (t.isUnion()) {
        // A union of one Tier-0 kind (e.g. NodeJS.Platform = string-literal union).
        const parts = t.types.map(p => tsTypeToSi(p, numberType))
        if (parts.every(p => p === 'String')) return 'String'
        if (parts.every(p => p === numberType)) return numberType
        if (parts.every(p => p === 'Bool')) return 'Bool'
    }
    return null
}

const snake = (n: string): string => n.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()

/** Build a one-file TS program that brings the source namespace into scope and
 *  return the namespace's value type + the checker. */
function loadNamespace(src: DtsSource): { type: ts.Type; checker: ts.TypeChecker; sf: ts.SourceFile } {
    const entry = '/__bindgen_dts_entry.ts'
    const text = src.module
        ? `import * as __M from '${src.module}';\nexport declare const __ns: typeof __M;`
        : `export declare const __ns: typeof ${src.global};`
    const opts: ts.CompilerOptions = {
        types: src.types,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ESNext,
        skipLibCheck: true,
        noEmit: true,
    }
    const host = ts.createCompilerHost(opts)
    const origGet = host.getSourceFile.bind(host)
    host.getSourceFile = (name, lang, onErr, should) =>
        name === entry ? ts.createSourceFile(entry, text, lang) : origGet(name, lang, onErr, should)
    host.fileExists = ((f: string) => f === entry || ts.sys.fileExists(f)) as any
    host.readFile = ((f: string) => (f === entry ? text : ts.sys.readFile(f))) as any

    const program = ts.createProgram([entry], opts, host)
    const checker = program.getTypeChecker()
    const sf = program.getSourceFile(entry)!
    const decl = sf.statements.find(ts.isVariableStatement) as ts.VariableStatement
    const sym = checker.getSymbolAtLocation(decl.declarationList.declarations[0].name)!
    return { type: checker.getTypeOfSymbolAtLocation(sym, sf), checker, sf }
}

/** Generate BindingSpecs from a Node/Bun `.d.ts` namespace via the TS checker. */
export function dtsToSpecs(src: DtsSource): DtsResult {
    const numberType = src.numberType ?? 'Float'
    const { type, checker, sf } = loadNamespace(src)
    const specs: BindingSpec[] = []
    const skipped: { member: string; reason: string }[] = []

    for (const prop of checker.getPropertiesOfType(type)) {
        const name = prop.getName()
        const propType = checker.getTypeOfSymbolAtLocation(prop, sf)
        const sigs = propType.getCallSignatures()
        if (sigs.length === 0) continue   // not a function (a property/namespace) — silently skip
        const sig = sigs[0]               // first overload (@extern has no overloading)
        const member = `${src.prefix}.${name}`

        const ret = tsTypeToSi(checker.getReturnTypeOfSignature(sig), numberType)
        const params: Param[] = []
        let bad: string | null = ret === null ? 'non-Tier-0 result' : null
        if (!bad) {
            for (const p of sig.getParameters()) {
                const pt = tsTypeToSi(checker.getTypeOfSymbolAtLocation(p, sf), numberType)
                if (pt === null) { bad = `non-Tier-0 param '${p.getName()}'`; break }
                params.push({ name: p.getName(), type: pt })
            }
        }
        if (bad) { skipped.push({ member, reason: bad }); continue }

        const argList = params.map(p => p.name).join(', ')
        specs.push({
            name: src.prefix ? `${src.prefix}_${snake(name)}` : snake(name),
            params,
            result: ret!,
            impl: { kind: 'call', expr: `${src.accessor}.${name}(${argList})` },
            source: `${src.types[0]}:${member}`,
        })
    }
    // Deterministic order (the checker's property order is stable but sort to be safe).
    specs.sort((a, b) => a.name.localeCompare(b.name))
    return { specs, skipped }
}
