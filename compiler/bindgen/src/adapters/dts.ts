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
    /** OR a list of bare GLOBAL functions to harvest (`fetch`, `structuredClone`,
     *  …) — synthesized into a namespace `{ fetch: typeof fetch; … }` so the same
     *  property walk binds them.  The accessor should be `globalThis`. */
    readonly globals?: string[]
    /** Ambient type packages to load (tsconfig `types`), e.g. ['node'] or ['bun-types']. */
    readonly types: string[]
    /** The JS expression that reaches the namespace at the host, e.g.
     *  "require('node:path')" or "Bun" — the impl recipe no `.d.ts` carries. */
    readonly accessor: string
    /** Binding-name prefix, e.g. 'path' → `path_basename`. */
    readonly prefix: string
    /** How to map TS `number` (the int-vs-float heuristic). Default 'Float'. */
    readonly numberType?: SiType
    /** Tier-2 object handling (ADR 0018).  'skip' (default) drops any binding
     *  with a non-Tier-0 object param/result.  'jsvalue' instead maps such object
     *  types to the externref handle `JSValue` — so object-returning / object-
     *  taking APIs become callable (the handle is opaque, engine-GC'd, web/bun).
     *  Callables (need real closures) and thenables (belong to the async path)
     *  are still NOT mapped; if such a param is optional it is simply dropped. */
    readonly objects?: 'skip' | 'jsvalue'
    /** Async handling (ADR 0018 F1b).  'suspending' turns a `Promise<T>`-returning
     *  member into a `@suspending @extern` binding whose result is the AWAITED `T`
     *  (the F1b reactor drives the suspension).  'skip' (default) drops Promise
     *  members.  Pairs with `objects:'jsvalue'` so `Promise<Response>` → JSValue. */
    readonly async?: 'skip' | 'suspending'
    /** Event/callback handling (ADR 0019 C2).  'closure' maps a CALLABLE param
     *  (a listener/callback) to the `Callback` closure-handle type — the guest
     *  passes `@export_callback(@closure(…))` and the host invokes it through the
     *  closure trampoline.  'skip' (default) drops callback-taking members. */
    readonly events?: 'skip' | 'closure'
}

export interface DtsResult {
    readonly specs: BindingSpec[]
    readonly skipped: { readonly member: string; readonly reason: string }[]
}

/** True for a TS type that needs a real closure (a function) — never a JSValue. */
const isCallable = (t: ts.Type): boolean => t.getCallSignatures().length > 0
/** True for a Promise-like type — it belongs to the async path (F1b/F3), not a
 *  synchronous object handle, so it is not mapped to JSValue. */
const isThenable = (t: ts.Type): boolean => {
    const then = t.getProperty('then')
    return then != null && (then.flags & ts.SymbolFlags.Method) !== 0
}

/** Resolve a TS type to a Tier-0 Silicon type, or — when `objects` is 'jsvalue'
 *  — the externref handle `JSValue` for a plain object type.  Returns null for a
 *  type that can't cross at all (callables, thenables, or a non-Tier-0 object in
 *  'skip' mode). */
function tsTypeToSi(t: ts.Type, numberType: SiType, objects: 'skip' | 'jsvalue'): SiType | null {
    const f = t.flags
    if (f & ts.TypeFlags.StringLike)  return 'String'
    if (f & ts.TypeFlags.NumberLike)  return numberType
    if (f & ts.TypeFlags.BooleanLike) return 'Bool'
    if (f & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) return 'Void'
    if (t.isUnion()) {
        // Classify each arm in the SAME `objects` mode, so an object arm becomes
        // JSValue under 'jsvalue' (this is what unblocks mixed unions like
        // `string | Buffer | URL` — Node's PathOrFileDescriptor).
        const parts = t.types.map(p => tsTypeToSi(p, numberType, objects))
        // A homogeneous Tier-0 union reduces to that type (e.g. NodeJS.Platform
        // = string-literal union → String).
        if (parts.every(p => p === numberType)) return numberType
        if (parts.every(p => p === 'Bool')) return 'Bool'
        // Any string arm → String: the guest can always supply a string (covers
        // `string | Buffer | URL` paths and `string`-literal unions).
        if (parts.some(p => p === 'String')) return 'String'
        // A mixed union of otherwise-bindable arms (objects/scalars) crosses as an
        // opaque JSValue handle in 'jsvalue' mode; an unbindable arm (callback,
        // thenable → null) sinks the whole union.
        if (objects === 'jsvalue' && parts.length > 0 && parts.every(p => p !== null)) return 'JSValue'
        return null
    }
    // Tier-2: a plain object/array crosses as an opaque externref handle.  A
    // function (needs a closure) or a Promise (async) is deliberately NOT a handle.
    if (objects === 'jsvalue' && (f & ts.TypeFlags.Object) && !isCallable(t) && !isThenable(t)) return 'JSValue'
    if (objects === 'jsvalue' && (f & ts.TypeFlags.Any)) return 'JSValue'
    return null
}

const snake = (n: string): string => n.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()

/** Build a one-file TS program that brings the source namespace into scope and
 *  return the namespace's value type + the checker. */
function loadNamespace(src: DtsSource): { type: ts.Type; checker: ts.TypeChecker; sf: ts.SourceFile } {
    const entry = '/__bindgen_dts_entry.ts'
    const text = src.module
        ? `import * as __M from '${src.module}';\nexport declare const __ns: typeof __M;`
        : src.globals
            ? `export declare const __ns: { ${src.globals.map(g => `${g}: typeof ${g}`).join('; ')} };`
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
    const objects = src.objects ?? 'skip'
    const asyncMode = src.async ?? 'skip'
    const events = src.events ?? 'skip'
    const { type, checker, sf } = loadNamespace(src)
    const specs: BindingSpec[] = []
    const skipped: { member: string; reason: string }[] = []

    /** A param is droppable (the host call simply omits it, falling back to the
     *  API default) when it is OPTIONAL (`?`) — used to skip an unrepresentable
     *  trailing arg (e.g. a JSON `reviver` callback) instead of rejecting the
     *  whole binding.  A rest param (`...args`) is NOT droppable: omitting it
     *  would silently change the call's meaning (e.g. `path.join(...paths)` →
     *  a no-arg `join()`), so such a binding stays skipped. */
    const droppable = (p: ts.Symbol): boolean => {
        const d = p.valueDeclaration
        return !!d && ts.isParameter(d) && d.questionToken != null && d.dotDotDotToken == null
    }

    /** Try to bind ONE overload to a Tier-0/JSValue signature.  Returns the
     *  param/result/suspending shape, or a `bad` reason explaining why this
     *  overload can't cross.  Pure — no `specs`/`skipped` mutation. */
    const trySig = (sig: ts.Signature): { params: Param[]; ret: SiType; suspending: boolean } | { bad: string } => {
        // ADR 0018 — a `Promise<T>` member becomes a `@suspending` binding whose
        // result is the AWAITED `T` (the reactor returns the resolved value, so the
        // awaited type must be externref/scalar — never linear String).
        const rawRet = checker.getReturnTypeOfSignature(sig)
        let suspending = false
        let ret: SiType | null
        if (asyncMode === 'suspending' && isThenable(rawRet)) {
            suspending = true
            const awaited = (checker.getTypeArguments(rawRet as ts.TypeReference) ?? [])[0]
            ret = awaited ? tsTypeToSi(awaited, numberType, objects) : 'Void'   // Promise<void> → Void
        } else {
            ret = tsTypeToSi(rawRet, numberType, objects)
        }
        if (ret === null) return { bad: suspending ? 'awaited type not bindable' : 'non-Tier-0 result' }
        const params: Param[] = []
        for (const p of sig.getParameters()) {
            const d = p.valueDeclaration
            // A rest param (`...args`) is variadic — it can't be a single fixed
            // param (and its array type must NOT be smuggled across as one JSValue:
            // `path.join([..])` ≠ `path.join(a, b)`).  Reject this overload.
            if (d && ts.isParameter(d) && d.dotDotDotToken != null) return { bad: `variadic rest param '${p.getName()}'` }
            const ptype = checker.getTypeOfSymbolAtLocation(p, sf)
            // ADR 0019 C2 — a callable param is a CALLBACK: bind it as the
            // closure-handle type `Callback` (the guest passes a closure).
            if (events === 'closure' && isCallable(ptype) && !isThenable(ptype)) {
                params.push({ name: p.getName(), type: 'Callback' }); continue
            }
            const pt = tsTypeToSi(ptype, numberType, objects)
            if (pt === null) {
                // An unrepresentable optional is dropped — but STOP there: keeping a
                // later param would shift it into the dropped param's positional
                // slot at the host call (e.g. JSON.stringify(value, replacer?, space?)
                // — dropping `replacer` then keeping `space` would pass space AS the
                // replacer).  Same policy as the webiface adapter.
                if (droppable(p)) break
                return { bad: `non-Tier-0 param '${p.getName()}'` }
            }
            params.push({ name: p.getName(), type: pt })
        }
        return { params, ret, suspending }
    }

    for (const prop of checker.getPropertiesOfType(type)) {
        const name = prop.getName()
        const propType = checker.getTypeOfSymbolAtLocation(prop, sf)
        const sigs = propType.getCallSignatures()
        if (sigs.length === 0) continue   // not a function (a property/namespace) — silently skip
        const member = `${src.prefix || src.global || src.module}.${name}`

        // Overload selection (#5): `@extern` has no overloading, so choose the
        // BEST bindable overload instead of blindly the first.  This recovers
        // members whose first overload is unrepresentable but a later one binds
        // (e.g. `Bun.spawn`/`write`/`file`), and — among bindable overloads —
        // prefers the most usable signature: fewest opaque handle params
        // (JSValue/Callback), then most concrete scalar/string params, then
        // earliest declaration.  So `file(path: string)` beats `file(fd, opts)`.
        const isHandle = (t: SiType) => t === 'JSValue' || t === 'Callback'
        let chosen: { params: Param[]; ret: SiType; suspending: boolean } | null = null
        let chosenScore: [number, number] = [Infinity, -1]   // [handleCount, -concreteCount]
        let lastBad = 'no bindable overload'
        for (const sig of sigs) {
            const r = trySig(sig)
            if ('bad' in r) { lastBad = r.bad; continue }
            const handles = r.params.filter(p => isHandle(p.type)).length
            const concrete = r.params.length - handles
            const score: [number, number] = [handles, -concrete]
            if (!chosen || score[0] < chosenScore[0] || (score[0] === chosenScore[0] && score[1] < chosenScore[1])) {
                chosen = r; chosenScore = score
            }
        }
        if (!chosen) { skipped.push({ member, reason: lastBad }); continue }

        const argList = chosen.params.map(p => p.name).join(', ')
        specs.push({
            name: src.prefix ? `${src.prefix}_${snake(name)}` : snake(name),
            params: chosen.params,
            result: chosen.ret,
            impl: { kind: 'call', expr: `${src.accessor}.${name}(${argList})` },
            source: `${src.types[0] ?? 'ecmascript'}:${member}`,
            suspending: chosen.suspending || undefined,
        })
    }
    // Deterministic order (the checker's property order is stable but sort to be safe).
    specs.sort((a, b) => a.name.localeCompare(b.name))
    return { specs, skipped }
}
