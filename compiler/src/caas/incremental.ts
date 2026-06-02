// SPDX-License-Identifier: MIT
/**
 * Incremental reparse (CaaS tracker 3b — milestone M1).
 *
 * On a text edit, instead of reparsing the whole file we reuse the top-level
 * elements whose parse result is provably unchanged and reparse only the
 * damaged window.  This exploits the parser's Zig-like property that top-level
 * elements parse independently (`parseProgram` loops independent `parseElement`
 * calls; the only carried state is the token cursor).
 *
 * Reuse rule (M1 keeps the existing absolute `sourceLocation` untouched, so it
 * only reuses elements whose stored positions cannot have changed):
 *   - **prefix** — elements ending at/before the edit: reused verbatim (their
 *     text and everything before them is unchanged → identical AST + spans).
 *   - **damaged window** — every element the edit touches: reparsed against the
 *     FULL new source, so positions come out absolute and correct.
 *   - **suffix** — elements starting after the edit: reused verbatim only when
 *     the edit changed no newline count AND no suffix element shares the edit's
 *     end line (so their stored line/col are unchanged).  Otherwise the window
 *     extends to EOF (prefix is still reused).
 *
 * Correctness is paramount: every caller falls back to a full reparse when this
 * module returns `null`, and an optional `SIGIL_INCREMENTAL_VERIFY=1` tripwire
 * (applied by the caller) compares against a full reparse and discards the
 * incremental tree on any mismatch.  Reusing shifted suffixes (line fix-up) and
 * sub-element sharing are later milestones (M2–M4).
 */

import type { Program } from '../ast/astNodes'
import { ASTFactory } from '../ast/astNodes'
import { computeLineStarts, lineColumnAt } from '../parser/handwritten/lexer'
import { parseProgramFragment, type ElementExtent } from '../parser/parser'
import { rangeToOffsets } from './textChange'
import type { TextChange } from './textChange'

/** Per-top-level-element byte extents recorded for an existing `SyntaxTree`. */
export type GreenIndex = readonly ElementExtent[]

/** A successful incremental reparse: the new program plus its fresh extents. */
export interface IncrementalResult {
    readonly program: Program
    readonly extents: ElementExtent[]
}

/** The byte region an edit damaged, in OLD-source coordinates. */
interface Damage {
    /** First byte that differs (old == new up to here). */
    readonly start: number
    /** One past the last differing byte, in OLD coordinates. */
    readonly endOld: number
}

// ---------------------------------------------------------------------------
// Damage-region computation
// ---------------------------------------------------------------------------

/**
 * Damage region for a set of `TextChange`s: the union `[min start, max end)` of
 * the changed ranges, in old-source byte coordinates.  Returns `null` when
 * there are no changes (nothing to do).
 */
export function damageFromChanges(oldSource: string, changes: readonly TextChange[]): Damage | null {
    if (changes.length === 0) return null
    let start = Infinity
    let endOld = -Infinity
    for (const c of changes) {
        const { start: s, end: e } = rangeToOffsets(oldSource, c.range)
        if (s < start) start = s
        if (e > endOld) endOld = e
    }
    return { start, endOld }
}

/**
 * Damage region for a full-text replacement: the span between the longest
 * common prefix and the longest common suffix of `oldSource` and `newSource`.
 * Returns `null` when the texts are identical.
 */
export function damageFromText(oldSource: string, newSource: string): Damage | null {
    if (oldSource === newSource) return null
    const oldLen = oldSource.length
    const newLen = newSource.length
    const maxPrefix = Math.min(oldLen, newLen)

    let p = 0
    while (p < maxPrefix && oldSource.charCodeAt(p) === newSource.charCodeAt(p)) p++

    // Longest common suffix, not overlapping the common prefix on either side.
    let s = 0
    const maxSuffix = Math.min(oldLen, newLen) - p
    while (s < maxSuffix && oldSource.charCodeAt(oldLen - 1 - s) === newSource.charCodeAt(newLen - 1 - s)) s++

    return { start: p, endOld: oldLen - s }
}

// ---------------------------------------------------------------------------
// Incremental reparse
// ---------------------------------------------------------------------------

/**
 * Reparse `newSource` incrementally given the old source and its `GreenIndex`.
 * Returns the new program + extents, or `null` if the fast path doesn't apply
 * (the caller must then full-reparse).
 */
export function incrementalReparse(
    oldSource: string,
    oldIndex: GreenIndex,
    newSource: string,
    damage: Damage,
): IncrementalResult | null {
    const delta = newSource.length - oldSource.length

    // Partition old elements: prefix (entirely before the edit) and suffix
    // candidates (entirely after the edit).  Anything else is "touched" and
    // lives inside the reparse window.
    const prefix: ElementExtent[] = []
    for (const e of oldIndex) {
        if (e.end <= damage.start) prefix.push(e)
        else break   // extents are ordered; first non-prefix ends the run
    }
    const suffix: ElementExtent[] = []
    for (const e of oldIndex) {
        if (e.start >= damage.endOld) suffix.push(e)
    }

    const windowStartByte = prefix.length > 0 ? prefix[prefix.length - 1].end : 0

    // Decide whether the suffix can be reused verbatim: its stored absolute
    // positions are unchanged only when the edit added/removed no newlines AND
    // no suffix element shares the edit's end line (a same-line column shift).
    const firstSuffix = suffix[0]
    let reuseSuffix = false
    if (firstSuffix !== undefined && countNewlines(newSource) === countNewlines(oldSource)) {
        const oldLineStarts = computeLineStarts(oldSource)
        const damageEndLine = lineColumnAt(oldLineStarts, oldSource, damage.endOld).line
        const firstSuffixLine = lineColumnAt(oldLineStarts, oldSource, firstSuffix.start).line
        reuseSuffix = firstSuffixLine > damageEndLine
    }

    const windowEndByteNew = reuseSuffix ? firstSuffix.start + delta : newSource.length

    // No reuse possible (window is the whole file) → let the caller full-reparse.
    if (windowStartByte === 0 && !reuseSuffix) return null

    // Reparse only the damaged window, against the full new source.
    const frag = parseProgramFragment(newSource, windowStartByte, windowEndByteNew)
    if (frag === null) return null

    // Assemble: reused prefix + freshly parsed window + reused (delta-shifted) suffix.
    // The suffix shifted by `delta` bytes: shallow-clone each element root with its
    // `elemBase` bumped (M3); descendants are shared by reference (their `relSpan`
    // is element-relative, so unchanged).  Prefix never moved → reused verbatim.
    const prefixNodes = prefix.flatMap(e => e.nodes)
    const suffixExtents: ElementExtent[] = reuseSuffix
        ? suffix.map(e => ({ nodes: shiftElemBase(e.nodes, delta), start: e.start + delta, end: e.end + delta }))
        : []
    const suffixNodes = suffixExtents.flatMap(e => e.nodes)

    const elements = [...prefixNodes, ...frag.nodes, ...suffixNodes]
    const extents = [...prefix, ...frag.extents, ...suffixExtents]
    return { program: ASTFactory.program(elements as any), extents }
}

// ---------------------------------------------------------------------------
// Verify tripwire helper
// ---------------------------------------------------------------------------

/**
 * Deterministic structural serialization of an AST (object keys sorted) for the
 * `SIGIL_INCREMENTAL_VERIFY` equivalence check.  Two ASTs are node-for-node
 * identical iff their `stableStringify` outputs are equal.
 */
export function stableStringify(value: unknown): string {
    return JSON.stringify(canonical(value))
}

function canonical(value: any): any {
    if (value === null || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(canonical)
    const out: Record<string, any> = {}
    for (const k of Object.keys(value).sort()) out[k] = canonical(value[k])
    return out
}

/**
 * Shallow-clone each top-level element root with its `elemBase` shifted by
 * `delta` byte (M3 suffix reuse); descendants are shared by reference.  Returns
 * the originals unchanged when `delta === 0`.  The old tree is never mutated.
 */
function shiftElemBase<T extends object>(nodes: readonly T[], delta: number): T[] {
    if (delta === 0) return nodes as T[]
    return nodes.map(root => {
        const base = (root as { elemBase?: number }).elemBase
        return base === undefined ? root : { ...root, elemBase: base + delta }
    })
}

function countNewlines(s: string): number {
    let n = 0
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++
    return n
}
