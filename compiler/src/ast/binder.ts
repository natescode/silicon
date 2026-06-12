// SPDX-License-Identifier: MIT
/**
 * Binder — lexical binding identity for an elaborated program (S1).
 *
 * The typechecker's CaaS maps are NAME-keyed (`symbolToSpans` records every
 * reference to `x` under "x"), which conflates a parameter `x` in one
 * function with a local `x` in another and with a top-level `x`.  This pass
 * walks the elaborated tree once and assigns each *local* name occurrence to
 * the concrete binding that introduces it — parameter, local definition, or
 * `@match` pattern field — mirroring the typechecker's scope rules:
 *
 *   - a definition body is ONE scope (`withScope` in the typechecker): params
 *     bind throughout the body, locals bind from their definition onward and
 *     leak out of nested blocks (no per-block scoping);
 *   - a local's initializer is checked BEFORE the local is bound, so
 *     `x := x + 1` reads the OUTER `x`;
 *   - `@match` variant-pattern fields bind only in their arm's body.
 *
 * Occurrences that resolve to no local binding are *free* — they belong to
 * the name-keyed top-level/cross-document machinery and are not recorded
 * here, except as the complement: `isLocalOccurrence` lets a caller filter
 * the name-keyed spans down to the genuinely top-level ones (so renaming a
 * top-level `x` no longer rewrites every shadowing local `x`).
 *
 * The pass is purely lexical (no types), deterministic, and O(nodes) — it
 * runs on both the full and incremental typecheck paths.
 */

import { astChildren } from './astChildren'
import { normalizeMatchArgs } from './matchArms'
import type { SourceSpan } from '../errors/diagnostic'
import { spanFromLocation } from '../errors/diagnostic'

/** One local binding (parameter / local definition / match-pattern field). */
export interface BindingInfo {
    readonly name: string
    readonly kind: 'parameter' | 'variable'
    /** The defining AST node (Parameter, Definition, or pattern-field node). */
    readonly node: object
    /** 0-based position among the function's non-literal parameters
     *  (parameters only) — lets the SemanticModel read the parameter's type
     *  off the containing function's signature. */
    readonly paramIndex?: number
    /** Name of the enclosing TOP-LEVEL definition — the `containingSymbol`. */
    readonly container: string
    /** Span of the defining name token (undefined for span-less ASTs). */
    readonly definitionSpan?: SourceSpan
    /** Spans of every USE of this binding (the definition span is separate). */
    readonly referenceSpans: SourceSpan[]
}

/** Position-queryable result of {@link bindProgram}. */
export class BindingIndex {
    readonly bindings: BindingInfo[] = []
    /** name → `line:col` keys of every occurrence (def or use) that resolved
     *  to a local binding.  The complement filter for name-keyed span maps. */
    readonly #localOccurrences = new Map<string, Set<string>>()

    /** @internal */
    _addOccurrence(name: string, span: SourceSpan | undefined): void {
        if (!span) return
        let set = this.#localOccurrences.get(name)
        if (!set) this.#localOccurrences.set(name, (set = new Set()))
        set.add(`${span.line}:${span.col}`)
    }

    /** The binding whose definition or a use covers `(line, col)` (1-based). */
    bindingAtPosition(line: number, col: number): BindingInfo | undefined {
        for (const b of this.bindings) {
            if (spanContains(b.definitionSpan, line, col)) return b
            for (const s of b.referenceSpans) {
                if (spanContains(s, line, col)) return b
            }
        }
        return undefined
    }

    /** True when the `(line, col)` of `span` is an occurrence of `name` that
     *  resolved to a LOCAL binding — i.e. a top-level query for `name` must
     *  NOT treat this span as one of its references. */
    isLocalOccurrence(name: string, span: SourceSpan): boolean {
        return this.#localOccurrences.get(name)?.has(`${span.line}:${span.col}`) ?? false
    }
}

/** True when the 1-based `(line, col)` cursor falls inside `span`. */
function spanContains(span: SourceSpan | undefined, line: number, col: number): boolean {
    if (!span || span.length === 0) return false
    if (span.line !== line) return false
    return col >= span.col && col < span.col + span.length
}

type Frame = Map<string, BindingInfo>

/** Build the {@link BindingIndex} for an elaborated program tree. */
export function bindProgram(program: object, file: string): BindingIndex {
    const index = new BindingIndex()
    const b = new Binder(index, file)
    for (const el of ((program as any).elements ?? []) as object[]) {
        b.walk(el, [], '')
    }
    return index
}

class Binder {
    constructor(
        private readonly index: BindingIndex,
        private readonly file: string,
    ) {}

    walk(node: any, frames: Frame[], container: string): void {
        if (node === null || typeof node !== 'object') return

        if (node.type === 'Definition') {
            this.walkDefinition(node, frames, container)
            return
        }

        if (node.type === 'Namespace') {
            const path: string[] = node.path ?? []
            // Only simple identifiers can be local; `mod::name` never is.
            if (path.length === 1) this.resolve(node, path[0], frames)
            return
        }

        if (isMatchCall(node)) {
            this.walkMatch(node, frames, container)
            return
        }

        for (const child of astChildren(node)) this.walk(child, frames, container)
    }

    /** A Definition introduces (a) itself as a local binding when nested in a
     *  body, and (b) a fresh scope frame holding its parameters. */
    walkDefinition(def: any, frames: Frame[], container: string): void {
        const name: string | undefined = def.name?.name
        const isTopLevel = frames.length === 0
        const innerContainer = isTopLevel ? (name ?? '') : container

        // Parameters — one frame for the whole body.
        const frame: Frame = new Map()
        let paramIndex = 0
        for (const p of (def.params ?? []) as any[]) {
            if (p.isLiteral) continue
            const binding: BindingInfo = {
                name: p.name,
                kind: 'parameter',
                node: p,
                paramIndex,
                container: innerContainer,
                definitionSpan: this.span(p),
                referenceSpans: [],
            }
            paramIndex++
            this.index.bindings.push(binding)
            this.index._addOccurrence(p.name, binding.definitionSpan)
            frame.set(p.name, binding)
        }

        // Body — checked BEFORE the definition's own name binds (the
        // typechecker registers `d.name.name` after the body), so
        // `x := x + 1` reads the outer `x`.
        if (def.binding) {
            const raw = Array.isArray(def.binding) ? def.binding[0] : def.binding
            this.walk(raw?.expression ?? raw, [...frames, frame], innerContainer)
        }

        // A NESTED definition is itself a local binding, visible to the
        // remainder of the enclosing body (sequential, function-level scope).
        if (!isTopLevel && name) {
            const binding: BindingInfo = {
                name,
                kind: 'variable',
                node: def,
                container,
                definitionSpan: this.span(def),
                referenceSpans: [],
            }
            this.index.bindings.push(binding)
            this.index._addOccurrence(name, binding.definitionSpan)
            frames[frames.length - 1].set(name, binding)
        }
    }

    /** `@match(disc, $Variant f0 f1, { arm }, …)` — pattern fields bind in
     *  their arm's body only (mirrors `checkMatchArgs`'s `withScope`). */
    walkMatch(call: any, frames: Frame[], container: string): void {
        const args = normalizeMatchArgs(call.args ?? [])
        if (args.length === 0) return
        this.walk(args[0], frames, container)                   // discriminant
        const hasDefault = (args.length - 1) % 2 === 1
        const armsEnd = hasDefault ? args.length - 1 : args.length
        for (let i = 1; i < armsEnd; i += 2) {
            const pat = args[i]
            const arm = args[i + 1]
            const variant = unwrapVariantDecl(pat)
            if (variant) {
                const frame: Frame = new Map()
                for (const f of (variant.fields ?? []) as any[]) {
                    if (!f?.name || f.isLiteral) continue
                    const binding: BindingInfo = {
                        name: f.name,
                        kind: 'variable',
                        node: f,
                        container,
                        definitionSpan: this.span(f),
                        referenceSpans: [],
                    }
                    this.index.bindings.push(binding)
                    this.index._addOccurrence(f.name, binding.definitionSpan)
                    frame.set(f.name, binding)
                }
                if (arm !== undefined) this.walk(arm, [...frames, frame], container)
            } else {
                this.walk(pat, frames, container)
                if (arm !== undefined) this.walk(arm, frames, container)
            }
        }
        if (hasDefault) this.walk(args[args.length - 1], frames, container)
    }

    /** Attribute one simple-name occurrence to the innermost binding, if any. */
    resolve(node: any, name: string, frames: Frame[]): void {
        for (let i = frames.length - 1; i >= 0; i--) {
            const binding = frames[i].get(name)
            if (binding) {
                const span = this.span(node)
                if (span) {
                    binding.referenceSpans.push(span)
                    this.index._addOccurrence(name, span)
                }
                return
            }
        }
        // Free occurrence — top-level / cross-document; name-keyed machinery
        // owns it.
    }

    span(node: any): SourceSpan | undefined {
        const loc = node?.sourceLocation
        return loc ? spanFromLocation(loc, this.file) : undefined
    }
}

function isMatchCall(node: any): boolean {
    if (node.type !== 'FunctionCall' || !node.isBuiltin) return false
    const name = typeof node.name === 'string'
        ? node.name
        : (node.name && Array.isArray(node.name.path) ? node.name.path.join('::') : '')
    return name === '@match'
}

/** Descend wrapper nodes to a `VariantDecl` pattern, if `node` is one. */
function unwrapVariantDecl(node: any): any | undefined {
    let cur = node
    while (cur && typeof cur === 'object') {
        if (cur.type === 'VariantDecl') return cur
        if (cur.expression) { cur = cur.expression; continue }
        if (cur.value && cur.type !== 'BinaryOp') { cur = cur.value; continue }
        return undefined
    }
    return undefined
}
