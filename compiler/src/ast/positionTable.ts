// SPDX-License-Identifier: MIT
/**
 * PositionTable — reconstructs absolute source positions for AST nodes from the
 * M3 relative-position encoding (CaaS tracker 3b).
 *
 * Positioned nodes (Definition, Namespace) carry a `relSpan` of byte offsets
 * **relative to their containing top-level element**; each element root carries
 * the element's absolute base offset in `elemBase`.  This table walks the tree
 * top-down, propagating each element's base to its descendants, and computes
 * absolute `SourceLocation` on demand via `elemBase + relSpan`.
 *
 * Both `elemBase` and `relSpan` are plain node fields, so they survive
 * elaboration's spread-cloning (the table is built fresh from whatever tree it
 * is given — parsed or elaborated). Incremental reuse shifts only the O(elements)
 * `elemBase` values; descendants stay shared by reference.
 *
 * The result is byte-identical to the old on-node absolute `sourceLocation`
 * (`elemBase + relSpan == the original token offset`, same `lineColumnAt`).
 */

import type { Program, SourceLocation } from './astNodes'
import type { SourceSpan } from '../errors/diagnostic'
import { spanFromLocation } from '../errors/diagnostic'
import { computeLineStarts, lineColumnAt } from '../parser/handwritten/lexer'
import { astChildren } from './astChildren'

export class PositionTable {
    readonly #source: string
    readonly #lineStarts: number[]
    /** Positioned node → its containing element's absolute base offset. */
    readonly #base = new WeakMap<object, number>()

    constructor(program: Program, source: string) {
        this.#source = source
        this.#lineStarts = computeLineStarts(source)
        for (const element of (program as { elements?: object[] }).elements ?? []) {
            const base = (element as { elemBase?: number }).elemBase
            if (typeof base === 'number') this.#stamp(element, base)
        }
    }

    /** Record every positioned descendant of `node` against its element `base`. */
    #stamp(node: any, base: number): void {
        if (node === null || typeof node !== 'object') return
        if (node.relSpan) this.#base.set(node, base)
        for (const child of astChildren(node)) this.#stamp(child, base)
    }

    /**
     * Absolute `SourceLocation` for `node`, or `undefined` when `node` has no
     * `relSpan` (i.e. it is one of the position-less node kinds) — identical to
     * reading an unset `sourceLocation` field.
     */
    loc(node: object): SourceLocation | undefined {
        const rel = (node as { relSpan?: { start: number; end: number } }).relSpan
        if (!rel) return undefined
        const base = this.#base.get(node)
        if (base === undefined) return undefined
        const a = lineColumnAt(this.#lineStarts, this.#source, base + rel.start)
        const b = lineColumnAt(this.#lineStarts, this.#source, base + rel.end)
        return { startLine: a.line, startColumn: a.column, endLine: b.line, endColumn: b.column }
    }

    /** `SourceSpan` in diagnostic shape — `spanFromLocation(loc(node), file)`. */
    spanOf(node: object, file = ''): SourceSpan {
        return spanFromLocation(this.loc(node), file)
    }
}

/** Build a `PositionTable` for `program` against its `source` text. */
export function buildPositionTable(program: Program, source: string): PositionTable {
    return new PositionTable(program, source)
}
