// SPDX-License-Identifier: MIT
/**
 * Incremental type-checking (CaaS incremental semantics, stage E2).
 *
 * The full type-checker (`typecheck()` in src/types/typechecker.ts) is, in order:
 *
 *     ctx = createCheckContext(...)          // fresh maps + a shared fresh-var gen
 *     preRegisterDefinitions(all elements)    // DECLARED sigs for forward refs
 *     for element of program.elements:        // main pass, IN SOURCE ORDER
 *         checkElement(element, ctx)          //   overwrites functions/symbols with
 *                                             //   BODY-INFERRED sigs; writes typeMap,
 *                                             //   errors, references for the subtree
 *     model = assembleSemanticModel(ctx)
 *
 * Two properties make this order load-bearing (see docs/incremental-typecheck-design.md):
 *   - the shared `ctx.fresh` counter leaks order-dependent `?Tn` into `model.typeOf`
 *     (e.g. `@let x := &None` stores `Option[?T1]`), and
 *   - an unannotated forward reference sees a callee's DECLARED sig, a backward one
 *     its INFERRED sig — so a checked element's result depends on what preceded it.
 *
 * So incremental checking is **"reuse the unchanged prefix, replay the changed
 * suffix in source order"**, NOT node-level reuse of only the edited element:
 *
 *   - The incremental PARSE/ELABORATE layer (E1a/E1b) classifies each new element
 *     group as a verbatim-reused prefix (`reused`, `delta:0`, `oldGroupIndex===i`),
 *     a freshly-parsed window, or a byte-shifted suffix.  The contiguous run of
 *     verbatim-reused groups from index 0 is the **type-reuse prefix**.
 *   - For each prefix group we **replay** its cached per-group write-set into a
 *     fresh ctx (its finalized sigs, typeMap slice, reference edges, diagnostics)
 *     and advance the shared fresh-var counter by the count it consumed — so the
 *     suffix re-check sees byte-identical ctx state and counter position.
 *   - Every group from the first non-prefix onward is **re-checked** with
 *     `checkElement`, after a full `preRegisterDefinitions` over the new element
 *     list restores the declared-sig baseline.  No span-shifting is needed: the
 *     reused prefix is delta-0, and re-checked elements are re-stamped from their
 *     current `elemBase`.
 *
 * The result is byte-identical to a full `typecheck()` on diagnostics, symbols,
 * and `model.typeOf` over every node.  `typecheck()` stays the untouched oracle:
 * the Workspace runs it as the fallback and, under `SIGIL_INCREMENTAL_VERIFY`,
 * as a discard-on-mismatch tripwire.
 *
 * @internal — not part of the stable public API.
 */

import type { Program } from '../ast/astNodes'
import { astChildren } from '../ast/astChildren'
import type { SiliconType } from '../types/types'
import type { TypeError } from '../types/errors'
import type { SemanticModel } from '../ast/semanticModel'
import type { ElaboratorRegistry } from '../elaborator/registry'
import type { ModuleRegistry } from '../modules/registry'
import type { LowerTarget } from '../ir/lower'
import { toDiagnostic, type Diagnostic, type SourceSpan } from '../errors/diagnostic'
import { buildPositionTable } from '../ast/positionTable'
import {
    createCheckContext,
    preRegisterDefinitions,
    checkElement,
    assembleSemanticModel,
    stampSourceLocations,
    type CheckContext,
    type FunctionSig,
} from '../types/typechecker'
import type { ElabGroup } from './incrementalElaborate'
import type { ElementReuse } from './incremental'

/**
 * The cached per-element-group type-check result — everything needed to replay a
 * verbatim-reused (delta-0) group's contribution into a fresh context without
 * re-running inference.  Aligned 1:1 with the compile's `ElabGroup[]`.
 */
export interface TypeGroupCache {
    /** Finalized (body-inferred) function signatures this group defined. */
    readonly finalizedFunctions: ReadonlyArray<readonly [string, FunctionSig]>
    /** Finalized symbol types this group defined. */
    readonly finalizedSymbols: ReadonlyArray<readonly [string, SiliconType]>
    /** node → type for every typed node in the group's subtrees (authoritative). */
    readonly typeSlice: ReadonlyArray<readonly [object, SiliconType]>
    /** reference node → resolved symbol name (nodeToSymbolName edges). */
    readonly symNameSlice: ReadonlyArray<readonly [object, string]>
    /** symbolToNodes appends, in source order: name → reference node. */
    readonly refNodes: ReadonlyArray<readonly [string, object]>
    /** symbolToSpans appends, in source order: name → reference span. */
    readonly refSpans: ReadonlyArray<readonly [string, SourceSpan]>
    /** Diagnostics this group produced, in push order. */
    readonly errors: ReadonlyArray<TypeError>
    /** Number of `ctx.fresh.next()` calls the group's check consumed (for counter replay). */
    readonly freshConsumed: number
}

export interface IncrementalTypecheckResult {
    readonly model: SemanticModel
    readonly diagnostics: Diagnostic[]
    /** Per-group cache aligned with the NEW group list (for the next edit). */
    readonly cache: TypeGroupCache[]
    /**
     * Signature of the pre-registration state (declared sigs, type aliases,
     * variant schemes, struct fields).  Carried to the next edit: prefix reuse is
     * only sound when it is unchanged (see `incrementalTypecheck`).
     */
    readonly preRegSig: string
    /** Groups whose result was replayed from cache rather than re-checked. */
    readonly reusedGroups: number
    readonly totalGroups: number
}

export interface IncrementalTypecheckOptions {
    readonly externalSymbols?: ReadonlyMap<string, SiliconType>
    readonly target?: LowerTarget
    readonly moduleRegistry?: ModuleRegistry
}

/** Prior compile's type-reuse state for an edit; omit for a fresh full check. */
export interface PriorTypeState {
    /** Reuse classification aligned with the NEW group list (`parseResult._elementReuse`). */
    readonly reuse: readonly ElementReuse[]
    /** Per-group cache aligned with the PRIOR group list. */
    readonly cache: readonly TypeGroupCache[]
    /** Prior compile's `preRegSig`; prefix reuse requires it to be unchanged. */
    readonly preRegSig: string
}

/** A counting wrapper over the shared fresh-var generator, for `freshConsumed`. */
interface CountingFresh {
    readonly count: () => number
    readonly advance: (n: number) => void   // advance the underlying gen without counting
}

function installFreshCounter(ctx: CheckContext): CountingFresh {
    const base = ctx.fresh
    let n = 0
    ctx.fresh = { next: (prefix = 'T') => { n++; return base.next(prefix) } }
    return { count: () => n, advance: (k) => { for (let i = 0; i < k; i++) base.next() } }
}

/** Length of every array value in `m`, for diffing per-name appends. */
function lengths(m: Map<string, unknown[]>): Map<string, number> {
    const out = new Map<string, number>()
    for (const [k, v] of m) out.set(k, v.length)
    return out
}

/** The (name → appended element) pairs added to `m` since the `before` snapshot, in order. */
function appendsSince<T>(m: Map<string, T[]>, before: Map<string, number>): Array<[string, T]> {
    const out: Array<[string, T]> = []
    for (const [name, arr] of m) {
        for (let i = before.get(name) ?? 0; i < arr.length; i++) out.push([name, arr[i]])
    }
    return out
}

function pushInto<T>(m: Map<string, T[]>, name: string, value: T): void {
    const arr = m.get(name)
    if (arr) arr.push(value)
    else m.set(name, [value])
}

/**
 * Stable signature of the pre-registration state — the DECLARED signatures, type
 * aliases, variant schemes, and struct fields that `preRegisterDefinitions` seeds
 * and that every element (including ones BEFORE it, via the pre-pass) can observe
 * for a forward reference.
 *
 * Prefix reuse is sound only while this is unchanged: a verbatim-unchanged prefix
 * element that forward-references a later element reads that later element's
 * DECLARED sig, so changing any declaration (annotation, params, a type, or
 * adding/removing/renaming a name) can change the prefix element's result even
 * though its own text didn't move.  A function/binding BODY edit leaves the
 * declared sigs untouched (bodies aren't seen by pre-registration), so the common
 * edit still reuses; declaration edits conservatively fall back to a full check.
 */
function preRegSignature(ctx: CheckContext): string {
    const sortPairs = (m: Iterable<readonly [string, unknown]>): Array<[string, unknown]> =>
        [...m].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    const structFields = sortPairs(ctx.structFields).map(([k, v]) => [k, sortPairs(v as Map<string, unknown>)])
    return JSON.stringify({
        f: sortPairs(ctx.functions),
        s: sortPairs(ctx.symbols),
        a: sortPairs(ctx.typeAliases),
        v: sortPairs(ctx.variantSchemes),
        sf: structFields,
        vc: [...ctx.variantConstructors].sort(),
        im: [...ctx.immutable].sort(),
    })
}

/** True for keywords whose Definitions write no finalized function/symbol sig. */
function isTypeDeclElement(node: any): boolean {
    const kw: string = node?.keyword ?? ''
    return kw === '@type' || kw === '@type_sum' || kw === '@enum'
        || kw === '@type_alias' || kw === '@type_distinct' || kw === '@struct' || kw === '@export'
}

/** Walk a group's subtrees collecting typeMap + nodeToSymbolName entries. */
function captureSlices(
    root: any,
    ctx: CheckContext,
    typeSlice: Array<[object, SiliconType]>,
    symNameSlice: Array<[object, string]>,
): void {
    if (root === null || typeof root !== 'object') return
    const t = ctx.typeMap.get(root)
    if (t !== undefined) typeSlice.push([root, t])
    const sn = ctx.nodeToSymbolName.get(root)
    if (sn !== undefined) symNameSlice.push([root, sn])
    for (const c of astChildren(root)) captureSlices(c, ctx, typeSlice, symNameSlice)
}

/** Splice a cached group's contribution into `ctx` (the prefix-replay step). */
function replayGroup(entry: TypeGroupCache, ctx: CheckContext, fresh: CountingFresh): void {
    for (const [name, sig] of entry.finalizedFunctions) ctx.functions.set(name, sig)
    for (const [name, ty] of entry.finalizedSymbols) ctx.symbols.set(name, ty)
    for (const [node, t] of entry.typeSlice) ctx.typeMap.set(node, t)
    for (const [node, name] of entry.symNameSlice) ctx.nodeToSymbolName.set(node, name)
    for (const [name, node] of entry.refNodes) pushInto(ctx.symbolToNodes, name, node)
    for (const [name, span] of entry.refSpans) pushInto(ctx.symbolToSpans, name, span)
    for (const e of entry.errors) ctx.errors.push(e)
    fresh.advance(entry.freshConsumed)
}

/**
 * The contiguous run of verbatim-reused groups from index 0 — the prefix whose
 * type-check results are unchanged and replayable.  A group qualifies only if it
 * is `reused`, unshifted (`delta === 0`), and maps to the SAME old index, AND a
 * cached entry exists for it.  The first group that fails ends the run; from
 * there to EOF everything is re-checked (Stage B: conservative, sound).
 */
function reusablePrefixLength(reuse: readonly ElementReuse[], cacheLen: number): number {
    let k = 0
    while (k < reuse.length) {
        const r = reuse[k]
        if (r.kind !== 'reused' || r.delta !== 0 || r.oldGroupIndex !== k) break
        if (r.oldGroupIndex >= cacheLen) break
        k++
    }
    return k
}

/**
 * Type-check `program` group-by-group, replaying the unchanged prefix from
 * `prior` when given and re-checking the suffix.  With no `prior` (or a prefix of
 * length 0) this re-checks every group and is byte-identical to a full
 * `typecheck()` — it always (re)builds the per-group cache for the next edit.
 */
export function incrementalTypecheck(
    program: Program,
    groups: readonly ElabGroup[],
    source: string,
    file: string,
    registry: ElaboratorRegistry,
    options: IncrementalTypecheckOptions = {},
    prior?: PriorTypeState,
): IncrementalTypecheckResult {
    // Absolute positions for this (current) tree, exactly as caas typecheck() does.
    const positions = buildPositionTable(program, source)
    stampSourceLocations(program, positions)

    const ctx = createCheckContext(registry, options.moduleRegistry, options.target, file, options.externalSymbols)
    // Declared-sig baseline over the FULL new element list (cheap, inference-free,
    // and exactly what the full pass seeds before its main loop).
    preRegisterDefinitions(program.elements as any[], ctx)
    const fresh = installFreshCounter(ctx)

    // Prefix reuse is sound only when no declaration changed (a prefix element may
    // forward-reference a later element's DECLARED sig).  A body edit keeps this
    // stable; a declaration edit forces a full re-check (prefixLen = 0).
    const preRegSig = preRegSignature(ctx)
    const prefixLen = prior && prior.preRegSig === preRegSig
        ? reusablePrefixLength(prior.reuse, prior.cache.length)
        : 0

    const cache: TypeGroupCache[] = []
    for (let i = 0; i < groups.length; i++) {
        const group = groups[i]
        if (i < prefixLen) {
            // Replay: the group is verbatim-unchanged (delta 0, same node objects).
            const entry = prior!.cache[i]
            replayGroup(entry, ctx, fresh)
            cache.push(entry)
            continue
        }
        // Re-check: capture this group's write-set as the full pass would produce it.
        const errLen0 = ctx.errors.length
        const nodeLens0 = lengths(ctx.symbolToNodes as Map<string, unknown[]>)
        const spanLens0 = lengths(ctx.symbolToSpans as Map<string, unknown[]>)
        const fresh0 = fresh.count()

        for (const node of group.nodes) checkElement(node, ctx)

        const typeSlice: Array<[object, SiliconType]> = []
        const symNameSlice: Array<[object, string]> = []
        const finalizedFunctions: Array<[string, FunctionSig]> = []
        const finalizedSymbols: Array<[string, SiliconType]> = []
        for (const root of group.nodes) {
            captureSlices(root, ctx, typeSlice, symNameSlice)
            const name: string | undefined = root?.name?.name
            if (name) {
                if (!isTypeDeclElement(root)) {
                    const sig = ctx.functions.get(name)
                    if (sig) finalizedFunctions.push([name, sig])
                }
                const sym = ctx.symbols.get(name)
                if (sym) finalizedSymbols.push([name, sym])
            }
        }
        cache.push({
            finalizedFunctions,
            finalizedSymbols,
            typeSlice,
            symNameSlice,
            refNodes: appendsSince(ctx.symbolToNodes, nodeLens0),
            refSpans: appendsSince(ctx.symbolToSpans, spanLens0),
            errors: ctx.errors.slice(errLen0),
            freshConsumed: fresh.count() - fresh0,
        })
    }

    const model = assembleSemanticModel(ctx)
    return {
        model,
        diagnostics: ctx.errors.map(e => toDiagnostic(e)),
        cache,
        preRegSig,
        reusedGroups: prefixLen,
        totalGroups: groups.length,
    }
}

/** Sign an external-symbols map so a cross-document change invalidates type reuse. */
export function externalSymbolsSignature(ext?: ReadonlyMap<string, SiliconType>): string {
    if (!ext || ext.size === 0) return ''
    const parts: string[] = []
    for (const [name, ty] of ext) parts.push(name + ' ' + JSON.stringify(ty))
    parts.sort()
    return parts.join('')
}

